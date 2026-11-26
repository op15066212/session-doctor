#!/usr/bin/env node
// 判据：在真实会话的副本上，把「全选并执行」走一遍，结构判据必须全过。
// 服务的真实事故（2026-11-26）：一个会话被拒写盘，理由是「thinking 块数不变 1103 → 1102」。
// 差 1 的原因是「孤立思考」—— 删这类整条消息必然少一个块，那是设计好的删除。
// 判据写成 === 不变，就把合法删除判红，于是那个文件永远清不掉。
// 正确口径：块数下降量 == 被删条目里带的块数。这条判据验的就是这个口径。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const lib = await import("./lib/session-fix.mjs");
const { readSession, findAnomalies, applyClean, applyFold, applyRelink, applyChosen, measure, verify, KIND, DEFAULTS } = lib;

const ROOT = process.env.SESSION_DOCTOR_DIR || path.join(process.env.PI_AGENT_HOME || path.join(os.homedir(), ".pi", "agent"), "sessions");
let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };

const files = [];
const walk = (dir) => { let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of ents) { const p = path.join(dir, d.name); if (d.isDirectory()) { if (!d.name.startsWith(".") && !["subagent-artifacts", "subagents", "pi-async"].includes(d.name)) walk(p); continue; } if (d.name.endsWith(".jsonl")) files.push(p); } };
walk(ROOT);
if (!files.length) {
  console.log("跳过（rc=2 环境缺失）：没找到会话文件 " + ROOT);
  process.exit(2);
}

let ran = 0, red = 0;
for (const file of files) {
  const { lines, entries } = await readSession(file);
  const raw = findAnomalies(entries);
  if (!raw.length) continue;
  const before = measure(lines);
  const chosen = raw.map((a) => ({ entry: a.entry, block: a.block, kind: a.kind }));
  const cleanIds = raw.filter((a) => a.kind === KIND.THINKING_SIGNATURE).map((a) => entries[a.entry]?.id).filter((x) => typeof x === "string");
  const rl = applyRelink(lines, entries, chosen);
  const cl = applyClean(rl.lines, entries, chosen);
  const fold = applyFold(cl.lines, entries, chosen, DEFAULTS);
  const fe = fold.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const rm = applyChosen(fold.lines, fe, chosen);
  const after = measure(rm.lines);
  const v = verify(before, after, { relinked: rl.relinked, cleaned: cl.cleaned, cleanIds, usersMerged: rm.usersMerged, asstRemoved: rm.asstRemoved, editsRevoked: rm.editsRevoked, thinkRemoved: rm.thinkRemoved });
  const bad = (v.checks || []).filter((c) => !c[1]);
  ran += 1;
  if (bad.length) { red += 1; console.log("     " + path.basename(file).slice(0, 24) + " " + JSON.stringify(bad)); }
}
ok("有异常的会话全选执行后结构判据全过", red === 0, ran + " 个会话，判红 " + red);

// 事故样本：把 thinkRemoved 故意漏传，那个有「孤立思考」的会话必须被判红。
// 不传就等于回到旧口径（=== 块数不变），而它正是拒绝写盘的那条。
let caught = 0;
for (const file of files) {
  const { lines, entries } = await readSession(file);
  const raw = findAnomalies(entries);
  if (!raw.some((a) => a.kind === KIND.THINKING_ONLY)) continue;
  const before = measure(lines);
  const chosen = raw.map((a) => ({ entry: a.entry, block: a.block, kind: a.kind }));
  const rl = applyRelink(lines, entries, chosen);
  const cl = applyClean(rl.lines, entries, chosen);
  const fold = applyFold(cl.lines, entries, chosen, DEFAULTS);
  const fe = fold.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const rm = applyChosen(fold.lines, fe, chosen);
  const after = measure(rm.lines);
  const v = verify(before, after, { relinked: rl.relinked, cleaned: cl.cleaned, usersMerged: rm.usersMerged, asstRemoved: rm.asstRemoved, editsRevoked: rm.editsRevoked });
  if ((v.checks || []).some((c) => !c[1] && /thinking 块数/.test(c[0]))) caught += 1;
}
ok("事故样本：漏传 thinkRemoved 时判据会红", caught > 0, "命中 " + caught + " 个带孤立思考的会话");

console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);