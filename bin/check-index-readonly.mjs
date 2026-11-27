#!/usr/bin/env node
/**
 * 判据：主扫描循环里不许写「预先建好的索引」。
 *
 * 为什么有（2026-11-27）：组 2 的判据是「两段共享可变结构，就不是两段」。
 * 我把这条用到自己的 findAnomalies 上，发现 seenImage 是边扫边写的——
 * 判定与记账混在同一个循环里，于是图片判定的结论依赖扫描顺序。那是拆不开的形状。
 *
 * 组 2 提的验法是「把索引 freeze，然后写回必须抛」。我复现了，**在 Map 上不成立**：
 *
 *     const m = new Map(); Object.freeze(m); m.set("a", 1)   -> 成功，size=1
 *
 * freeze 冻结的是对象的属性，Map 的数据在内部 [[MapData]] 槽里，不经过属性。
 * 所以「freeze 后写回没抛」不能证明代码只读，反而会让人以为验过了。
 * 对普通对象 freeze 才有效（strict mode 下赋值抛 TypeError）。
 *
 * 这条判据改走静态：主循环之后的文本里，任何索引变量都不许出现写操作。
 * 索引变量从盘上自动发现（主循环之前声明的 new Map() / new Set()），不维护清单。
 *
 * rc: 0 全部只读｜1 有写｜2 找不到主循环锚点
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "lib", "session-fix.mjs");

/** 只取 findAnomalies 的函数体：文件里还有 chainOf / measure，它们的写操作不算。 */
export function bodyOf(src, fnName) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("export function " + fnName + "("));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "}") end += 1;
  if (end >= lines.length) return null;
  return { lines: lines.slice(start, end + 1), startLine: start + 1, eol: lines[0] && src.includes("\r\n") ? "\r\n" : "\n" };
}

/** 主循环的锚点：在 findAnomalies 内、紧跟在 cutoffIndex 之后的那条 for。 */
export function splitAtMainLoop(src) {
  const body = bodyOf(src, "findAnomalies");
  if (!body) return null;
  const lines = body.lines;
  const cut = lines.findIndex((l) => l.includes("const cut = cutoffIndex("));
  if (cut < 0) return null;
  const loop = lines.findIndex((l, i) => i > cut && /^  for \(let i = 0; i < entries\.length; i \+= 1\) \{$/.test(l));
  if (loop < 0) return null;
  return { head: lines.slice(0, loop).join(body.eol), tail: lines.slice(loop).join(body.eol), loopLine: body.startLine + loop };
}

/** 索引变量：findAnomalies 从 buildIndexes 解构出来的那些。 */
export function indexNames(head) {
  const out = new Set();
  // 2026-11-27 起索引声明搬进了 buildIndexes，判定段只拿解构结果。
  // 从解构行取，而不是从 new Map/Set 取——后者已经不在这个函数里了。
  for (const m of head.matchAll(/^  const \{ ([^}]+) \} = buildIndexes\(/gm)) {
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) out.add(n);
  }
  // 兼容旧形状：若还没抽出 buildIndexes，就退回按声明取。
  for (const m of head.matchAll(/^\s*const ([A-Za-z_$][\w$]*) = new (?:Map|Set)\(\);/gm)) out.add(m[1]);
  return [...out];
}

/** 主循环里出现的索引写操作。 */
export function writesInTail(names, tail) {
  const hits = [];
  for (const n of names) {
    const re = new RegExp("\\b" + n + "\\.(set|add|delete|clear)\\s*\\(", "g");
    for (const m of tail.matchAll(re)) hits.push(n + "." + m[1]);
  }
  return hits;
}

if (process.argv.includes("--selftest")) {
  const fake = [
    "export function findAnomalies(entries, opts = {}) {",
    "  const { index, dead } = buildIndexes(entries, {});",
    "  const cut = cutoffIndex(entries, 1);",
    "  for (let i = 0; i < entries.length; i += 1) {",
    "    index.set(i, 1);",
    "    const x = dead.get(i);",
    "  }",
    "  return [];",
    "}"
  ].join("\n");
  const s = splitAtMainLoop(fake);
  const names = indexNames(s.head);
  const w = writesInTail(names, s.tail);
  const cases = [
    ["切分出主循环（在 findAnomalies 内）", !!s && s.loopLine === 4],
    ["认出两个索引", names.length === 2 && names.includes("index") && names.includes("dead")],
    ["主循环里 index.set 被报出", w.includes("index.set")],
    ["只读的 dead 不被报", !w.some((x) => x.startsWith("dead."))],
    ["没有写操作时返回空", writesInTail(names, "  const y = index.get(0);").length === 0]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad += 1; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 切分与写操作识别都成立");
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  const src = fs.readFileSync(SRC, "utf8");
  const s = splitAtMainLoop(src);
  if (!s) { console.error("找不到主循环锚点（rc=2）"); process.exit(2); }
  const names = indexNames(s.head);
  const writes = writesInTail(names, s.tail);
  console.log("主循环在第 " + s.loopLine + " 行；之前建好的索引 " + names.length + " 个：" + names.join(", "));
  if (writes.length) {
    for (const w of writes) console.log("  红    " + w + "：判定段在写索引，两段共享可变结构");
    console.log("");
    console.log("索引在判定段被写 " + writes.length + " 处");
    process.exit(1);
  }
  console.log("判定段只读：没有任何索引被写回");
  process.exit(0);
}