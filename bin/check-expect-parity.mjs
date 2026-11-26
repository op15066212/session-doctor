#!/usr/bin/env node
// 判据：所有调用 verify() 的入口，传的「预期减少量」必须成套，一个都不许漏。
// 事故（2026-11-26）：命令行 pruner 只传 usersMerged/asstRemoved，没传 editsRevoked ——
// 于是凡是删过 context_edit 的会话一律 FAIL，报「存活 target 的最后一条改写不变=…(没了)」，
// 而那条改写是**有意撤销**的。判据是对的，调用方漏传 —— 这类缺陷只有一个形状：漏字段。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRUTH = join(REPO, "..", ".pi", "agent", "bin");
let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };
// 必传清单：每一个都对应 verify 里一条会红的口径。少一个，正当动作就会被判成缺陷。
const REQUIRED = ["usersMerged", "asstRemoved", "editsRevoked", "thinkRemoved"];

// 入口清单：新增入口要登记在这里（下面第一条断言保证清单不是空的）。
const ENTRIES = [
  join(TRUTH, "prune-session.mjs"),
  join(TRUTH, "fold-session.mjs"),
  join(REPO, "bin", "session-doctor.mjs"),
];

const scanned = [];
for (const file of ENTRIES) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  const lines = src.split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indexOf("verify(") < 0) continue;
    if (line.indexOf("export function verify") >= 0) continue;
    const expr = line + " " + (lines[i + 1] || "");
    if (expr.indexOf("{") < 0) continue;
    const missing = REQUIRED.filter((k) => expr.indexOf(k) < 0);
    scanned.push({ file, line: i + 1, missing });
  }
}

ok("扫到了调用点（清单非空）", scanned.length > 0, scanned.length + " 处");
let bad = 0;
for (const s of scanned) {
  if (!s.missing.length) continue;
  bad += 1;
  const name = s.file.split(/[\\/]/).pop();
  console.log("     " + name + ":" + s.line + " 漏传 " + s.missing.join(","));
}
ok("每个入口传齐必需键", bad === 0, scanned.length + " 处调用，漏传 " + bad);

const fake = "verify(before, after, { usersMerged, asstRemoved })";
const fakeMissing = REQUIRED.filter((k) => fake.indexOf(k) < 0);
ok("坏样本：只传两个会被判出来", fakeMissing.length === 2, "看得见漏 " + fakeMissing.join(","));

console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);