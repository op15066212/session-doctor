#!/usr/bin/env node
/**
 * 判据：一个异常类要么有坏样本，要么被点名记在基线里。基线只能缩小。
 *
 * 为什么有（2026-11-27）：组 2 提议把 bin/lib/session-fix.mjs（1155 行）拆成三层，
 * 条件是「拆完 17 类异常的坏样本逐条红」。我先把这句话变成可查的东西，结论是：
 * 17 类里 13 类没有任何坏样本，4 类只在 check-ui-e2e.mjs（要 Electron）里被提到。
 * 也就是说「拆完样本逐条红」这个验收条件当场不成立——样本还不存在。
 * 先补样本，再谈拆分。
 *
 * 判据形状与理由：
 *   kind 出现在任何 bin/check-*.mjs 或 test/ 文件里 = 有样本
 *   没有样本但在 BASELINE 里 = 允许（基线写理由）
 *   没有样本且不在 BASELINE 里 = rc=1（新增一类异常却没给样本）
 *   BASELINE 里的类现在有了样本 = 提示一句，rc 仍 0
 *     （这一条不红，因为「要求人删基线」会变成噪音；但提示会一直在，直到人删）
 *
 * rc: 0 通过｜1 有新增异常类缺样本｜2 读不到判定源
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SRC = path.join(REPO, "bin", "lib", "session-fix.mjs");

if (!fs.existsSync(SRC)) { console.error("读不到判定源：" + SRC); process.exit(2); }

/** 判定源里 KIND 的全部取值（字符串字面量，按值比较，不按常量名）。 */
export function kindsIn(src) {
  const block = src.match(/export const KIND = \{([\s\S]*?)\n\};/);
  if (!block) return [];
  const out = [];
  for (const m of block[1].matchAll(/^\s*[A-Z_]+:\s*"([^"]+)"/gm)) out.push(m[1]);
  return out;
}

/** 在磁盘上「有样本」= 这个 kind 的字符串出现在某个 check-*.mjs 或 test/ 文件里。 */
export function coveredBy(kind, files) {
  return files.filter((f) => f.text.includes(kind)).map((f) => f.path);
}

function loadProbes() {
  const out = [];
  const binDir = path.join(REPO, "bin");
  for (const f of fs.readdirSync(binDir)) {
    if (/^check-.*\.mjs$/.test(f) && f !== "check-anomaly-coverage.mjs") {
      out.push({ path: "bin/" + f, text: fs.readFileSync(path.join(binDir, f), "utf8") });
    }
  }
  const testDir = path.join(REPO, "test");
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      if (/\.(mjs|js|ts)$/.test(f)) out.push({ path: "test/" + f, text: fs.readFileSync(path.join(testDir, f), "utf8") });
    }
  }
  return out;
}

if (process.argv.includes("--selftest")) {
  const src = fs.readFileSync(SRC, "utf8");
  const kinds = kindsIn(src);
  const fake = [{ path: "bin/check-x.mjs", text: "坏样本：" + kinds[0] }];
  const cases = [
    ["从判定源读出全部异常类（>= 10）", kinds.length >= 10],
    ["有样本的类能被认出", coveredBy(kinds[0], fake).length === 1],
    ["没样本的类认不出（用一个不存在的 kind）", coveredBy("zzz-not-a-kind", fake).length === 0]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad++; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 抽取与比对都成立");
  process.exit(bad ? 1 : 0);
}

const kinds = kindsIn(fs.readFileSync(SRC, "utf8"));
if (!kinds.length) { console.error("读不出 KIND 全表（rc=2）"); process.exit(2); }
const probes = loadProbes();

// 基线：已知缺样本的类。写理由，且只能缩小——补了样本就从这里删掉。
const BASELINE = new Map(Object.entries({
  "dangling-edit": "需要 context_edit 指向不存在目标",
  "dup-image": "需要两条消息含同一张图",
  "big-thinking": "需要超 minBytes 的 thinking 块",
  "big-toolcall": "需要超 minBytes 的工具参数",
  "whitespace-only": "需要只有空白文本块",
  "unreachable": "需要从根沿 parentId 走不到的条目",
  "image-overflow": "需要超过图片上限的会话",
  "thinking-signature": "需要带 signature 的 thinking 块",
  "context-edit-dup": "需要 context_edit 复制目标且只截短 thinking",
  "context-edit-stale": "需要同一目标的两条 context_edit"
}));

let missing = 0;
let stale = 0;
for (const k of kinds) {
  const hit = coveredBy(k, probes);
  if (hit.length) {
    if (BASELINE.has(k)) { console.log("  提示  " + k + " 已有样本（" + hit[0] + "），可从基线删掉"); stale++; }
    continue;
  }
  if (BASELINE.has(k)) continue;
  console.log("  红    " + k + " 没有任何坏样本，也不在基线里");
  missing++;
}

const uncovered = kinds.filter((k) => !coveredBy(k, probes).length);
console.log("");
console.log("异常类共 " + kinds.length + " 类：有样本 " + (kinds.length - uncovered.length) + " / 缺样本 " + uncovered.length);
if (stale) console.log("基线里 " + stale + " 类已被覆盖，可从 BASELINE 删掉");
if (missing) { console.log("新增 " + missing + " 类缺样本（基线只能缩小，不能新增）"); process.exit(1); }
process.exit(0);