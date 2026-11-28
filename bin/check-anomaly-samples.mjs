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
 *   dangling-edit       context_edit 指向不存在的 target —— 永远不生效
 *   context-edit-stale  同一 target 的旧改写账本 —— 已被后来者顶掉
 *   context-edit-dup    replacement 是目标消息的复制、只截短 thinking —— 插件 bug 形状
 *   thinking-signature  思考块带 API 签名 —— openai-completions 下是纯冗余字节
 *   zero-token        空 content + usage.totalTokens 0 —— 失败的模型调用留下的空壳
 *   dup-system        同一份 system 快照存过多次 —— 只保留最后一份
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
    name: "unresolved-toolcall：多个调用仅摘除没有结果的调用",
    entries: [
      user("u1", null, "跑一下"),
      asst("a1", "u1", [
        { type: "text", text: "好的" },
        { type: "toolCall", id: "call-dead-a", name: "bash", arguments: {} },
        { type: "toolCall", id: "call-live", name: "read", arguments: {} },
        { type: "toolCall", id: "call-dead-b", name: "write", arguments: {} }
      ]),
      { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "call-live", content: "done" } },
      user("u2", "r1", "继续")
    ],
    opts: OLD,
    expect: KIND.UNRESOLVED_TOOLCALL,
    count: 2
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
  },
  {
    name: "dangling-edit：context_edit 指向不存在的 target",
    // 「省略一条不存在的消息」——永远不生效。旧口径只处理 replacement=null，
    // 2026-11-26 改成两者都不生效都该清（之前那 54 条一直躺着没人管）。
    entries: [user("u1", null, "hi"), { type: "context_edit", targetId: "gone", replacement: null }],
    opts: {},
    expect: KIND.DANGLING_EDIT
  },
  {
    name: "dangling-edit 反例：target 存在 → 不许报",
    entries: [user("u1", null, "hi"), { type: "context_edit", targetId: "u1", replacement: null }],
    opts: {},
    forbid: KIND.DANGLING_EDIT
  },
  {
    name: "context-edit-stale：同一 target 两条，前一条被顶掉",
    // append-only 覆盖：读时取最后一条，前面每条都不进上下文。
    // 实测某会话 478 个 target、平均每个被写 275 次——收益最大的一条无损清理。
    entries: [
      user("u1", null, "hi"),
      { type: "context_edit", targetId: "u1", replacement: null, seq: 1 },
      { type: "context_edit", targetId: "u1", replacement: null, seq: 2 }
    ],
    opts: {},
    expect: KIND.CONTEXT_EDIT_STALE
  },
  {
    name: "context-edit-stale 反例：同一 target 只有一条（即最后一条）→ 不许报",
    entries: [user("u1", null, "hi"), { type: "context_edit", targetId: "u1", replacement: null }],
    opts: {},
    forbid: KIND.CONTEXT_EDIT_STALE
  },
  {
    name: "context-edit-dup：replacement 是目标的复制，只有 thinking 被截短",
    // 插件 bug 的形状：非 thinking 块逐字节相同、块数一致，thinking 文本变了。
    // 两个条件缺一不可——只差 thinkingSignature 的那种是 pi-think-sentry 的成果，不是垃圾。
    entries: [
      user("u1", null, "hi"),
      asst("a1", "u1", [{ type: "thinking", thinking: "很长的原始思考" }, { type: "text", text: "答案" }]),
      { type: "context_edit", targetId: "a1", replacement: { content: [{ type: "thinking", thinking: "短" }, { type: "text", text: "答案" }] } }
    ],
    opts: {},
    expect: KIND.CONTEXT_EDIT
  },
  {
    name: "context-edit-dup 反例：只差 thinkingSignature（清签名的成果）→ 不许报",
    // 2026-11-26 实测的相反形状：pi-think-sentry 在 turn_end 写的覆盖记录与 bug 逐字节同形，
    // 但它是插件清签名的成果。判据收紧成「thinking 文本不同才算复制品」。
    entries: [
      user("u1", null, "hi"),
      asst("a1", "u1", [{ type: "thinking", thinking: "原始思考" }, { type: "text", text: "答案" }]),
      { type: "context_edit", targetId: "a1", replacement: { content: [{ type: "thinking", thinking: "原始思考" }, { type: "text", text: "答案" }] } }
    ],
    opts: {},
    forbid: KIND.CONTEXT_EDIT
  },
  {
    name: "thinking-signature：思考块带 API 签名",
    // 与体量无关，只要带就报（对 openai-completions 是纯冗余字节）。
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "x", thinkingSignature: "sig-abc123" }, { type: "text", text: "答案" }])],
    opts: {},
    expect: KIND.THINKING_SIGNATURE
  },
  {
    name: "thinking-signature 反例：没有签名字段 → 不许报",
    entries: [user("u1", null, "hi"), asst("a1", "u1", [{ type: "thinking", thinking: "x" }, { type: "text", text: "答案" }])],
    opts: {},
    forbid: KIND.THINKING_SIGNATURE
  },
  {
    name: "zero-token：空 content 且 0 token（失败的模型调用留下的空壳）",
    // 两个条件都要满足。只有 content 空但 token > 0 的，是模型真返回了空正文，另一种类。
    entries: [{ type: "message", id: "a0", parentId: null, message: { role: "assistant", content: [], usage: { totalTokens: 0 } } }],
    opts: {},
    expect: KIND.ZERO_TOKEN
  },
  {
    name: "zero-token 反例：content 空但 token > 0（模型真返回了空正文）→ 不许报",
    entries: [{ type: "message", id: "a0", parentId: null, message: { role: "assistant", content: [], usage: { totalTokens: 42 } } }],
    opts: {},
    forbid: KIND.ZERO_TOKEN
  },
  {
    name: "dup-system：同一份 system 快照存了两次，前一条被顶掉",
    // 活跃 prompt 每次重建，同一份内容会存几十次；只留最后一份。
    entries: [
      { type: "message", id: "s1", parentId: null, message: { role: "system", content: "同一份提示词" } },
      { type: "message", id: "s2", parentId: "s1", message: { role: "system", content: "同一份提示词" } }
    ],
    opts: {},
    expect: KIND.DUP_SYSTEM
  },
  {
    name: "dup-system 反例：两份内容不同的 system → 不许报",
    entries: [
      { type: "message", id: "s1", parentId: null, message: { role: "system", content: "提示词 A" } },
      { type: "message", id: "s2", parentId: "s1", message: { role: "system", content: "提示词 B" } }
    ],
    opts: {},
    forbid: KIND.DUP_SYSTEM
  },
  {
    name: "dup-image 边界：同一条 message 里两张相同的图 → 必须报 1 条",
    // 这条挡的是「按 entry 下标判重」的写法：若只比较 entry 下标，
    // 同一 entry 内的第 2 张会被当成「首次出现」而漏报。
    // 正确判据是按 (entry, block) 组合判「是否首次」。
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }, { type: "image", data: DOT_PNG, mimeType: "image/png" }])
    ],
    opts: {},
    expect: KIND.DUP_IMAGE,
    count: 1
  },
  {
    name: "dup-image 边界：三张相同的图分三条 message → 必须报 2 条（第 2、3 张）",
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a2", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      asst("a3", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }])
    ],
    opts: {},
    expect: KIND.DUP_IMAGE,
    count: 2
  },
  // ===== 冲突样本：一个输入同时命中两类，验的是「谁先 return」=====
  //
  // 这一组是我缺的（组 2 2026-11-27 指出）：原来 34 条全是「独有类」输入——
  // 只该一条成立的，于是只验了「每条能不能单独赢」，没验「同时赢时谁赢」。
  // 而后者才是判定顺序的真实内容：前一条 return 了，后一条就是死代码。
  //
  // 没有冲突样本时，把某条判据的代码删掉，样本可能一条都不红——
  // 因为它本来就没轮到过。
  {
    name: "冲突：死调用 + 超长参数 → 应报 unresolved-toolcall，不该报 big-toolcall",
    // 两条判据都成立：toolCall 没有 toolResult（死引用）、参数值超 minBytes（可折叠）。
    // 设计的优先级是「摘掉死引用」先——它连引用都不成立，折叠参数没有意义。
    entries: [
      user("u1", null, "写文件"),
      asst("a1", "u1", [{ type: "text", text: "好" }, { type: "toolCall", id: "c-dead", name: "write", arguments: { content: "z".repeat(11000) } }]),
      user("u2", "a1", "继续")
    ],
    opts: OLD,
    exactly: [KIND.UNRESOLVED_TOOLCALL]
  },
  {
    name: "冲突：思考既有签名又超长 → 应报 big-thinking，不该报 thinking-signature",
    // 这两条不互斥：签名判定在体量判定之外，两条都该报。用它证明「不互斥」也被记录着。
    // 判据是 exactly 列出两个——若实现改成「先 return」，这里立刻红。
    entries: [
      user("u1", null, "hi"),
      asst("a1", "u1", [{ type: "thinking", thinking: "y".repeat(11000), thinkingSignature: "sig-abc" }, { type: "text", text: "答案" }]),
      user("u2", "a1", "继续")
    ],
    opts: OLD,
    exactly: [KIND.BIG_THINKING, KIND.THINKING_SIGNATURE]
  },
  {
    // ===== 块级不互斥：同一个 for k 循环里的 continue 只跳当前块 =====
    //
    // 推：block 级判定的 continue 只跳过这一块，不跳过整条 message，
    // 所以同一 message 里两个块各自命中不同 kind 时，两个都该报。
    // 若实现里哪天有人把一个 continue 写成 break 或跳到外层，这条立刻红。
    //
    // 这也是我确认「36 条够用」的依据：block 级之间不存在互斥，
    // 互斥只发生在 message 级（content 空 / 只有 thinking / 只有空白），
    // 而那几类的条件本身互斥，不可能同时命中。
    name: "块级不互斥：同一 message 里超长正文 + 带签名的思考 → 两条都报",
    entries: [
      user("u1", null, "hi"),
      asst("a1", "u1", [{ type: "thinking", thinking: "x", thinkingSignature: "sig-abc" }, { type: "text", text: "z".repeat(11000) }]),
      user("u2", "a1", "继续")
    ],
    opts: OLD,
    exactly: [KIND.BIG_TEXT, KIND.THINKING_SIGNATURE]
  },
  {
    // 同一个 for k 循环内的块级不互斥：dup-image 的 continue 只跳那个 image 块，
    // 不跳过同一条 message 里后面的 text 块。
    // 若有人把 continue 写成 break 或跳到外层，这条立刻红。
    name: "块级不互斥（同循环）：重复图片 + 超长正文 → 两条都报",
    entries: [
      user("u1", null, "看图"),
      asst("a1", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }, { type: "text", text: "z".repeat(11000) }]),
      asst("a2", "u1", [{ type: "image", data: DOT_PNG, mimeType: "image/png" }]),
      user("u3", "a2", "继续")
    ],
    opts: OLD,
    exactly: [KIND.BIG_TEXT, KIND.DUP_IMAGE]
  }
];

// 条数断言：等于，不是大于等于。
//
// 组 2 2026-11-27 的做法我照抄（他拆六合一判据时漏了 5 条样本，而没有任何一处报出来）：
// 大于等于挡不住「删一条补一条」，而等于会逼人同时改两处——
// 那个同时改的动作正是要被看见的：改的人必须问一句「我为什么在改这个数」。
//
// 它先拦住的不是故意删除，是我自己的手滑：加块级样本时我插错位置、
// 多一个收尾大括号、漏一个 name，三次都是这条断言或语法检查先报出来的。
const EXPECTED = 38;
if (CASES.length !== EXPECTED) {
  console.log("FAIL  样本条数 " + CASES.length + "，期望 " + EXPECTED + "（有人删、合并或插错了样本）");
  bad += 1;
}
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
  if (c.exactly) {
    // 恰好这些，不多不少。冲突样本用它：既要「该赢的赢」，也要「不该赢的没赢」。
    const got = [...new Set(kinds)].sort().join(",");
    const want = [...new Set(c.exactly)].sort().join(",");
    const ok = got === want;
    console.log((ok ? "PASS  " : "FAIL  ") + c.name + (ok ? "" : "  [实得 " + (got || "无") + "，期望 " + want + "]"));
    if (!ok) bad += 1;
    continue;
  }
  if (c.expect) {
    const times = kinds.filter((k) => k === c.expect).length;
    const ok = c.count === undefined ? times > 0 : times === c.count;
    const why = c.count === undefined ? "" : (times + " 次，期望 " + c.count);
    console.log((ok ? "PASS  " : "FAIL  ") + c.name + (ok ? "" : "  [该 kind " + why + "；实得 " + (kinds.join(", ") || "无") + "]"));
    if (!ok) bad += 1;
  } else {
    const ok = !kinds.includes(c.forbid);
    console.log((ok ? "PASS  " : "FAIL  ") + c.name + (ok ? "" : "  [被误报为 " + c.forbid + "]"));
    if (!ok) bad += 1;
  }
}

console.log("");
if (bad) { console.log("坏样本判据：" + bad + " 条不符"); process.exit(1); }
// 类数按 kind 去重，不按 CASES.length / 2 推算。
// 2026-11-27 自踩：给 dup-image 加了 2 条边界样本后，输出从「16 类」变成「17 类」——
// 那个数一直假设「每类恰好两条」，是一种「声明的数不自增」的反面：
// 数会自己涨，而它数的不是它声称数的东西。
const classCount = new Set(CASES.map((c) => c.expect ?? c.forbid)).size;
const posCount = CASES.filter((c) => c.expect).length;
const negCount = CASES.filter((c) => c.forbid).length;
console.log("坏样本判据：" + classCount + " 类，" + CASES.length + " 条用例（正 " + posCount + " / 反 " + negCount + "），全部成立");
process.exit(0);