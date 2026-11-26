#!/usr/bin/env node
/**
 * 从备份回填 thinking 块。
 *
 * 什么时候用：会话里的 thinking 块被清掉了（2026-11-26 真发生：摘块函数不看 kind，
 * 把 17 个会话共 22024 个 thinking 块整块摘掉，而当时判据只数签名字段，一路绿灯）。
 *
 * 语义：以**备份**为来源、以**现文件**为骨架，按消息 id 对齐，把备份里的 thinking 块插回原位。
 * 三条不许违反：
 *   ① 行数不变（只改既有条目的 content，不增不删条目）；
 *   ② id 与 parentId 逐条不变（链不动，所以界面上的会话不会错位）；
 *   ③ 只补 thinking 正文，**不补 thinkingSignature**（签名本来就是清理对象）。
 * 不满足就拒绝写盘。
 *
 * 用法：
 *   node bin/restore-thinking.mjs                  # dry-run，只报能补多少
 *   node bin/restore-thinking.mjs --write          # 写盘（先备份到 .session-backups）
 *   node bin/restore-thinking.mjs --dir <会话目录> # 指定会话根
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const pickArg = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WRITE = args.includes("--write");
const PI_HOME = process.env.PI_AGENT_HOME || path.join(os.homedir(), ".pi", "agent");
const SESSIONS = pickArg("dir", path.join(PI_HOME, "sessions"));
const BACKUPS = pickArg("backup", path.join(PI_HOME, ".session-backups"));

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const idOf = (name) => (name.match(UUID) || [])[1];
const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const thinkCount = (entries) => entries.reduce((n, e) => n + (Array.isArray(e?.message?.content) ? e.message.content.filter((b) => b?.type === "thinking").length : 0), 0);

const walk = (dir, out = []) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walk(p, out); continue; }
    if (d.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};

// 每个会话取「thinking 最多」的那份备份做来源：后来的备份可能本身就是被清过的。
const best = new Map();
for (const f of walk(BACKUPS)) {
  const id = idOf(path.basename(f));
  if (!id) continue;
  let entries;
  try { entries = readJsonl(f); } catch { continue; }
  const th = thinkCount(entries);
  const prev = best.get(id);
  if (!prev || th > prev.th) best.set(id, { th, entries });
}

const plan = [];
for (const name of walk(SESSIONS).map((p) => p) ) {
  if (!name.endsWith(".jsonl")) continue;
  const id = idOf(path.basename(name));
  if (!id) continue;
  const src = best.get(id);
  if (!src) continue;
  const raw = fs.readFileSync(name, "utf8");
  const lines = raw.split("\n");
  const entries = lines.filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const bakById = new Map();
  for (const e of src.entries) if (e?.id) bakById.set(e.id, e);

  const outLines = [];
  let idx = 0;
  let restored = 0;
  let exact = 0;
  let fallback = 0;
  const beforeIds = [];
  const afterIds = [];
  for (const line of lines) {
    if (!line.trim()) { outLines.push(line); continue; }
    const e = entries[idx];
    idx += 1;
    if (e?.id) beforeIds.push(e.id + "|" + (e.parentId ?? ""));
    const be = e?.id ? bakById.get(e.id) : null;
    const bakContent = be?.message?.content;
    const curContent = e?.message?.content;
    const curHasTh = Array.isArray(curContent) && curContent.some((b) => b?.type === "thinking");
    const bakTh = Array.isArray(bakContent) ? bakContent.filter((b) => b?.type === "thinking") : [];
    if (!bakTh.length || curHasTh || !Array.isArray(curContent)) {
      outLines.push(line);
      if (e?.id) afterIds.push(e.id + "|" + (e.parentId ?? ""));
      continue;
    }
    const bakBody = bakContent.filter((b) => b?.type !== "thinking");
    const same = JSON.stringify(curContent) === JSON.stringify(bakBody);
    const clean = bakTh.map((b) => { const c = { ...b }; delete c.thinkingSignature; return c; });
    let next;
    if (same) {
      next = [];
      let bi = 0;
      for (const blk of bakContent) {
        if (blk?.type === "thinking") { next.push(clean.shift() || blk); continue; }
        next.push(curContent[bi]);
        bi += 1;
      }
      exact += bakTh.length;
    } else {
      // 现 content 与「备份去掉 thinking」不完全相同（别的清理改过它）：保守放最前，并计数。
      next = [...clean, ...curContent];
      fallback += bakTh.length;
    }
    e.message.content = next;
    restored += bakTh.length;
    outLines.push(JSON.stringify(e));
    if (e?.id) afterIds.push(e.id + "|" + (e.parentId ?? ""));
  }
  if (!restored) continue;
  // 两条硬条件：链不动、行数不变。
  const chainSame = JSON.stringify(beforeIds) === JSON.stringify(afterIds);
  if (!chainSame) {
    console.error(name + "：id/parentId 会变，拒绝处理");
    process.exitCode = 1;
    continue;
  }
  plan.push({ file: name, outLines, restored, exact, fallback });
  console.log(path.basename(name).slice(0, 26).padEnd(26) + " 补回 " + restored + "（精确 " + exact + " / 兜底 " + fallback + "）");
}

const total = plan.reduce((n, p) => n + p.restored, 0);
console.log("—— 文件 " + plan.length + " 个，可补 thinking " + total);
if (!WRITE) {
  console.log("未写盘（dry-run）。加 --write 才写。");
  process.exit(process.exitCode || 0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(BACKUPS, stamp + "_restore-thinking");
fs.mkdirSync(backupDir, { recursive: true });
for (const p of plan) {
  fs.copyFileSync(p.file, path.join(backupDir, path.basename(p.file)));
  const tmp = p.file + ".restore-tmp";
  fs.writeFileSync(tmp, p.outLines.join("\n"));
  fs.renameSync(tmp, p.file);
}
console.log("已写盘，改前备份在 " + backupDir);