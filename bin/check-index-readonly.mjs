#!/usr/bin/env node
/**
 * 判据：judgeEntries 的判定段不许写索引。
 *
 * 为什么有（2026-11-27，组 2 的判据「两段共享可变结构，就不是两段」）：
 * 我把这条用到自己的 findAnomalies 上，发现 seenImage 是边扫边写的——
 * 判定与记账混在同一个循环里，于是图片判定的结论依赖扫描顺序。那是拆不开的形状。
 *
 * 组 2 提的验法是「把索引 freeze，然后写回必须抛」。我复现了，**在 Map 上不成立**：
 *
 *     const m = new Map(); Object.freeze(m); m.set("a", 1)   -> 成功，size=1
 *
 * freeze 冻结的是对象属性；Map 的数据在内部 [[MapData]] 槽里，不经过属性。
 * 所以「freeze 后写回没抛」不能证明代码只读，反而会让人以为验过了。
 * 对普通对象 freeze 才有效（strict mode 下赋值抛 TypeError）。
 *
 * 这条判据走静态：judgeEntries 体内，任何索引变量都不许出现写操作。
 * 索引名从解构行自动取（const { ... } = idx），不维护清单。
 *
 * 为什么作用域是 judgeEntries 而不是「整文件」：这个仓有三处同名 ids
 * （judgeEntries / measure / applyRemoval），按名字扫整文件必然误报。
 * 我试过扩到整文件，两处误报，撤了。判据的真值依赖它的作用域，作用域错了它就成了噪音。
 *
 * rc: 0 全部只读｜1 有写｜2 找不到 judgeEntries 或主循环
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "lib", "session-fix.mjs");
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const split = (s) => s.split(new RegExp(CR + "?" + LF));

/** 取一个顶层函数体的行（从 export function X( 到列 0 的 }）。 */
export function bodyOf(src, fnName) {
  const lines = split(src);
  const start = lines.findIndex((l) => l.startsWith("export function " + fnName + "("));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "}") end += 1;
  if (end >= lines.length) return null;
  return { lines: lines.slice(start, end + 1), startLine: start + 1, eol: src.indexOf(CR) >= 0 ? CR + LF : LF };
}

/** 索引变量：judgeEntries 从 idx 解构出来的那些。 */
export function indexNames(head) {
  const out = new Set();
  // 2026-11-27 起索引由 buildIndexes 建成、judgeEntries 解构得到。
  for (const m of head.matchAll(/^  const \{ ([^}]+) \} = (?:buildIndexes\(|idx;)/gm)) {
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) out.add(n);
  }
  // 兼容旧形状：若还没抽出 buildIndexes，就退回按声明取。
  for (const m of head.matchAll(/^\s*const ([A-Za-z_$][\w$]*) = new (?:Map|Set)\(\);/gm)) out.add(m[1]);
  return [...out];
}

/** 文本里出现的索引写操作。 */
export function writesInTail(names, tail) {
  const hits = [];
  for (const n of names) {
    const re = new RegExp("\\b" + n + "\\.(set|add|delete|clear)\\s*\\(", "g");
    for (const m of tail.matchAll(re)) hits.push(n + "." + m[1]);
  }
  return hits;
}

/** 切出 judgeEntries 的「建完之后」那段：主循环之前是解构，之后是判定。 */
export function splitAtMainLoop(src) {
  const body = bodyOf(src, "judgeEntries");
  if (!body) return null;
  const lines = body.lines;
  const loop = lines.findIndex((l) => /^  for \(let i = 0; i < entries\.length; i \+= 1\) \{$/.test(l));
  if (loop < 0) return null;
  return { head: lines.slice(0, loop).join(body.eol), tail: lines.slice(loop).join(body.eol), loopLine: body.startLine + loop };
}

if (process.argv.includes("--selftest")) {
  const fake = [
    "export function judgeEntries(entries, o, idx) {",
    "  const { index, dead } = idx;",
    "  const out = [];",
    "  for (let i = 0; i < entries.length; i += 1) {",
    "    index.set(i, 1);",
    "    const x = dead.get(i);",
    "  }",
    "  return out;",
    "}"
  ].join(LF);
  const s = splitAtMainLoop(fake);
  const names = s ? indexNames(s.head) : [];
  const w = s ? writesInTail(names, s.tail) : [];
  const cases = [
    ["切分出主循环（在 judgeEntries 内）", !!s && s.loopLine === 4],
    ["认出两个索引", names.length === 2 && names.includes("index") && names.includes("dead")],
    ["主循环里 index.set 被报出", w.includes("index.set")],
    ["只读的 dead 不被报", !w.some((x) => x.startsWith("dead."))],
    ["没有写操作时返回空", writesInTail(names, "  const y = index.get(0);").length === 0],
    ["找不到 judgeEntries 时返回 null", splitAtMainLoop("export function other() {" + LF + "}") === null]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad += 1; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 切分与写操作识别都成立");
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  const src = fs.readFileSync(SRC, "utf8");
  const s = splitAtMainLoop(src);
  if (!s) { console.error("找不到 judgeEntries 或它的主循环（rc=2）"); process.exit(2); }
  const names = indexNames(s.head);
  const writes = writesInTail(names, s.tail);
  console.log("主循环在第 " + s.loopLine + " 行；解构得到的索引 " + names.length + " 个：" + names.join(", "));
  if (writes.length) {
    for (const w of writes) console.log("  红    " + w + "：判定段在写索引，两段共享可变结构");
    console.log("");
    console.log("索引在判定段被写 " + writes.length + " 处");
    process.exit(1);
  }
  console.log("判定段只读：没有任何索引被写回");
  process.exit(0);
}