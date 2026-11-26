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

// 事故样本：把 thinkRemoved 故意漏传，判据必须红。
// 不传就等于回到旧口径（=== 块数不变），而它正是拒绝写盘的那条。
//
// 样本**自己造**，不扫盘（2026-11-26 改）：原先靠「盘上恰好有个带孤立思考的会话」，
// 而人一旦把那些会话清完，坏样本就找不到对象、判据变红 —— 红的是判据自己的依赖。
// 造一条最小会话：一条只有 thought 的 assistant（孤立思考）+ 一轮正常问答把它推出 keepTurns。
const T2 = "2026-11-26T01:00:00.000Z";
const fixture = [
  { type: "message", id: "f0", parentId: null, timestamp: T2, message: { role: "user", content: [{ type: "text", text: "开场" }] } },
  { type: "message", id: "f1", parentId: "f0", timestamp: T2, message: { role: "assistant", content: [{ type: "thinking", thinking: "只有思考，没有正文。" }] } },
];
for (let i = 0; i < 40; i += 1) {
  const u = "fu" + i; const a = "fa" + i;
  const prev = i === 0 ? "f1" : "fa" + (i - 1);
  fixture.push({ type: "message", id: u, parentId: prev, timestamp: T2, message: { role: "user", content: [{ type: "text", text: "问 " + i }] } });
  fixture.push({ type: "message", id: a, parentId: u, timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "答 " + i }] } });
}
const fLines = fixture.map((x) => JSON.stringify(x));
const fRaw = findAnomalies(fixture);
ok("自造样本里有孤立思考", fRaw.some((x) => x.kind === KIND.THINKING_ONLY), fRaw.filter((x) => x.kind === KIND.THINKING_ONLY).length + " 条");
const fBefore = measure(fLines);
const fChosen = fRaw.map((x) => ({ entry: x.entry, block: x.block, kind: x.kind }));
const fRl = applyRelink(fLines, fixture, fChosen);
const fCl = applyClean(fRl.lines, fixture, fChosen);
const fFold = applyFold(fCl.lines, fixture, fChosen, DEFAULTS);
const fFe = fFold.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const fRm = applyChosen(fFold.lines, fFe, fChosen);
const fAfter = measure(fRm.lines);
// 漏传 thinkRemoved：回到旧口径，这条必须红。
const fV = verify(fBefore, fAfter, { relinked: fRl.relinked, cleaned: fCl.cleaned, usersMerged: fRm.usersMerged, asstRemoved: fRm.asstRemoved, editsRevoked: fRm.editsRevoked });
const caught = (fV.checks || []).filter((c) => !c[1] && /thinking 块数/.test(c[0])).length;
ok("事故样本：漏传 thinkRemoved 时判据会红", caught === 1, "红 " + caught + " 条，块数 " + fBefore.thinkBlocks + " → " + fAfter.thinkBlocks);

console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);