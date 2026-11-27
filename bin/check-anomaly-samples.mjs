#!/usr/bin/env node
/**
 * 判据：三类最容易造、且都是真事故形状的异常，必须各有坏样本。
 *
 * 为什么单独一个文件（2026-11-27）：check-anomaly-coverage.mjs 查「哪些类没有样本」，
 * 它报出 17 类里 13 类缺样本，其中三类最容易造成样本、也最像真事故：
 *   bad-line            一行不是合法 JSON —— 写到一半断电、编码坏掉
 *   broken-link         parentId 指向不存在的 id —— 前端只渲染断点之后，前面几千条看不见
 *   unresolved-toolcall 工具调用没有对应结果 —— 中断留下的死引用
 *   thinking-only       只有思考、无正文、无可合并兄弟 —— 流式中断的碎片
 *   whitespace-only     全部文本块都是空白 —— 模型返回了空正文
 *   dup-image           同一张图在会话里出现过 —— 第 2 份起无新信息
 *   big-text            老轮次里超 minBytes 的正文 —— 可折叠（留头尾）
 *   big-thinking        老轮次里超 minBytes 的思考 —— 可折叠
 *   big-toolcall        老轮次里超 minBytes 的工具参数 —— 可折叠
 *   image-overflow      链上图片超过单次请求上限 —— 每轮 400，会话永久卡死
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
const { findAnomalies, KIND, DOT_PNG } = M;
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
  },
  {
    name: "thinking-only：只有思考、无正文、无可合并兄弟",
    // 判定在 i < cut 块内：显式 keepTurns=1 把可折叠区推到第一条之后。
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "想了想" }]), user("u2", "a1", "继续")],
    opts: OLD,
    expect: KIND.THINKING_ONLY
  },
  {
    name: "thinking-only 反例：有正文同条 → 不许报（不是碎片，是正常回答）",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "想了想" }, { type: "text", text: "答案" }]), user("u2", "a1", "继续")],
    opts: OLD,
    forbid: KIND.THINKING_ONLY
  },
  {
    name: "whitespace-only：全部文本块都是空白",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "text", text: "   " }]), user("u2", "a1", "继续")],
    opts: OLD,
    expect: KIND.WS_ONLY
  },
  {
    name: "whitespace-only 反例：文本非空白 → 不许报",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "text", text: "有字" }]), user("u2", "a1", "继续")],
    opts: OLD,
    forbid: KIND.WS_ONLY
  },
  {
    name: "dup-image：同一张图出现两次（第 2 份起无新信息）",
    // 不需要 keepTurns：图片判定在 inScope 之前。
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a2", "a1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }])
    ],
    opts: {},
    expect: KIND.DUP_IMAGE
  },
  {
    name: "dup-image 反例：两张不同的图 → 不许报",
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a2", "a1", [{ type: "image", data: DOT_PNG.slice(0, -4) + "AAAA", mimeType: "image/png" }])
    ],
    opts: {},
    forbid: KIND.DUP_IMAGE
  },
  {
    name: "big-text：老轮次里超 minBytes（默认 10240）的正文",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "text", text: "x".repeat(11000) }]), user("u2", "a1", "继续")],
    opts: OLD,
    expect: KIND.BIG_TEXT
  },
  {
    name: "big-text 反例：短正文 → 不许报",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "text", text: "x".repeat(100) }]), user("u2", "a1", "继续")],
    opts: OLD,
    forbid: KIND.BIG_TEXT
  },
  {
    name: "big-thinking：老轮次里超 minBytes（默认 10240）的思考",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "y".repeat(11000) }, { type: "text", text: "答案" }]), user("u2", "a1", "继续")],
    opts: OLD,
    expect: KIND.BIG_THINKING
  },
  {
    name: "big-thinking 反例：短思考 → 不许报",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "y".repeat(100) }, { type: "text", text: "答案" }]), user("u2", "a1", "继续")],
    opts: OLD,
    forbid: KIND.BIG_THINKING
  },
  {
    name: "big-toolcall：老轮次里超 minBytes 的工具参数",
    // 两个条件都要满足：整串 > minBytes，且至少一个参数值本身 > minBytes。
    entries: [user("u1", null, "写文件"), asst("a1", "u1", [{ type: "text", text: "好" }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "x.txt", content: "z".repeat(11000) } }]), { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: "ok" } }, user("u2", "r1", "继续")],
    opts: OLD,
    expect: KIND.BIG_TOOLCALL
  },
  {
    name: "big-toolcall 反例：整串超阈值但没有单个超阈值的长参数 → 不许报",
    // 这条反例针对的是「两个条件」里最容易被漏掉的第二个：
    // arguments 里塞很多中等长度的键，整串 > minBytes，但每个值都不到阈值。
    entries: [
      user("u1", null, "写文件"),
      asst("a1", "u1", [{ type: "text", text: "好" }, { type: "toolCall", id: "c1", name: "write", arguments: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["k" + i, "v".repeat(300)])) }]),
      user("u2", "a1", "继续")
    ],
    opts: OLD,
    forbid: KIND.BIG_TOOLCALL
  },
  {
    name: "image-overflow：链上图片超过单次请求上限",
    // 真事故形状：上游按单次请求张数报 400，多出来的每一轮都 400，会话永久卡死。
    // 上限是 opts.maxImages（默认 20）。用 maxImages=2 + 3 张图，等价于「21 张图 + 20 上限」。
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a2", "a1", [{ type: "image", data: DOT_PNG.slice(0, -4) + "AAAB", mimeType: "image/png" }]),
      asst("a3", "a2", [{ type: "image", data: DOT_PNG.slice(0, -4) + "AAAC", mimeType: "image/png" }])
    ],
    opts: { maxImages: 2 },
    expect: KIND.IMAGE_OVERFLOW
  },
  {
    name: "image-overflow 反例：张数没超上限 → 不许报",
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a2", "a1", [{ type: "image", data: DOT_PNG.slice(0, -4) + "AAAB", mimeType: "image/png" }])
    ],
    opts: { maxImages: 2 },
    forbid: KIND.IMAGE_OVERFLOW
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