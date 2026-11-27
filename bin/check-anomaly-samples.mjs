#!/usr/bin/env node
/**
 * 判据：三类最容易造、且都是真事故形状的异常，必须各有坏样本。
 *
 * 为什么单独一个文件（2026-11-27）：check-anomaly-coverage.mjs 查「哪些类没有样本」，
 * 它报出 17 类里 13 类缺样本，其中三类最容易造成样本、也最像真事故：
 *   bad-line            一行不是合法 JSON —— 写到一半断电、编码坏掉
 *   broken-link         parentId 指向不存在的 id —— 前端只渲染断点之后，前面几千条看不见
 *   unresolved-toolcall 工具调用没有对应结果 —— 中断留下的死引用
 * 这条判据把那三类钉住，覆盖率基线随之缩小。
 *
 * 每一类都配一条反例（同类输入但该放行），因为只验「坏样本会红」会让
 * 「一切都报红」也通过——那与「一切都不报红」一样是无判据。
 *
 * rc: 0 三类都认出、反例都放行｜1 有类没认出或有反例被误报｜2 读不到判定源
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "lib", "session-fix.mjs");

let M;
try {
  M = await import(pathToFileURL(SRC).href);
} catch (err) {
  console.error("读不到判定源：" + SRC + " — " + (err?.message ?? err));
  process.exit(2);
}
const { findAnomalies, KIND } = M;
if (typeof findAnomalies !== "function" || !KIND) { console.error("判定源缺 findAnomalies / KIND（rc=2）"); process.exit(2); }

// keepTurns 默认 30：可折叠区是「最近 30 轮之外」。
// 样本只有几条消息，所以显式 keepTurns=1 把可折叠区推到第一条之后 ——
// 这不是放宽，是让 4 条消息的样本落在结构上等同「30 轮之前」的位置。
const OLD = { keepTurns: 1 };

const user = (id, parentId, text) => ({ type: "message", id, parentId, message: { role: "user", content: text } });
const asst = (id, parentId, content) => ({ type: "message", id, parentId, message: { role: "assistant", content } });

function kindsOf(entries, opts) {
  return findAnomalies(entries, opts).map((a) => a.kind);
}

const CASES = [
  {
    name: "bad-line：一行不是合法 JSON",
    // readSession 把解析失败的行变成 null；判定源认 null 为 bad-line。
    entries: [user("u1", null, "hi"), null],
    opts: {},
    expect: KIND.BAD_LINE
  },
  {
    name: "bad-line 反例：全是合法条目 → 不许报",
    entries: [user("u1", null, "hi")],
    opts: {},
    forbid: KIND.BAD_LINE
  },
  {
    name: "broken-link：parentId 指向本文件没有的 id",
    // 真事故形状（2026-11-26 实测）：一条 assistant 的 parentId 指向从没落盘的 id，
    // leaf 往回走一步就停住，前端只渲染断点之后 9 轮，前面 4000 多条还在文件里却看不见。
    entries: [user("u1", null, "hi"), asst("a1", "never-written-id", [{ type: "text", text: "ok" }])],
    opts: {},
    expect: KIND.BROKEN_LINK
  },
  {
    name: "broken-link 反例：parentId 指回真有的条目 → 不许报",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "text", text: "ok" }])],
    opts: {},
    forbid: KIND.BROKEN_LINK
  },
  {
    name: "unresolved-toolcall：toolCall 没有对应 toolResult",
    // 这条 assistant 有正文 + 一个死调用：判定摘掉那个块，不删整条。
    entries: [
      user("u1", null, "跑一下"),
      asst("a1", "u1", [{ type: "text", text: "好的" }, { type: "toolCall", id: "call-dead", name: "bash", arguments: {} }]),
      user("u2", "a1", "继续")
    ],
    opts: OLD,
    expect: KIND.UNRESOLVED_TOOLCALL
  },
  {
    name: "unresolved-toolcall 反例：有对应 toolResult → 不许报",
    entries: [
      user("u1", null, "跑一下"),
      asst("a1", "u1", [{ type: "text", text: "好的" }, { type: "toolCall", id: "call-ok", name: "bash", arguments: {} }]),
      { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "call-ok", content: "done" } },
      user("u2", "r1", "继续")
    ],
    opts: OLD,
    forbid: KIND.UNRESOLVED_TOOLCALL
  }
];

let bad = 0;
for (const c of CASES) {
  let kinds;
  try {
    kinds = kindsOf(c.entries, c.opts);
  } catch (err) {
    console.log("FAIL  " + c.name + "  [抛出：" + (err?.message ?? err) + "]");
    bad += 1;
    continue;
  }
  if (c.expect) {
    const ok = kinds.includes(c.expect);
    console.log((ok ? "PASS  " : "FAIL  ") + c.name + (ok ? "" : "  [实得 " + (kinds.join(", ") || "无") + "]"));
    if (!ok) bad += 1;
  } else {
    const ok = !kinds.includes(c.forbid);
    console.log((ok ? "PASS  " : "FAIL  ") + c.name + (ok ? "" : "  [被误报为 " + c.forbid + "]"));
    if (!ok) bad += 1;
  }
}

console.log("");
if (bad) { console.log("坏样本判据：" + bad + " 条不符"); process.exit(1); }
console.log("坏样本判据：" + (CASES.length / 2) + " 类，各有正样本与反例，全部成立");
process.exit(0);