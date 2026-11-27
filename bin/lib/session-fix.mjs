/**
 * 会话异常的**唯一判定源**（prune-session / fold-session / session-doctor 三个入口共用）。
 *
 * 为什么抽成一处：判定规则原先写在两个 CLI 里，第三个入口（GUI）要出同样的清单，
 * 三处各写一遍必然分叉——改了判据忘了一处，界面上看到的东西和实际执行的就不一样。
 * 这里只做两件事：**认异常**（findAnomalies）与**算结果**（applyRemoval / applyFold），
 * 不碰 argv、不碰盘上写、不弹提示。写盘与备份由调用方决定。
 *
 * 七类异常，每类都写明「为什么它不是内容」：
 *   bad-line      解析失败的行：不删（删了可能带走真内容），只报告
 *   zero-token    assistant：content 空 + usage.totalTokens 0 = 失败的模型调用留下的空壳
 *   dup-system    system 快照：同一份 prompt 存过几十次，活跃 prompt 每次重建，只留最后一份
 *   dangling-edit context_edit：targetId 指向已不存在的条目且 replacement=null = 省略一条不存在的消息
 *   dup-image     图片：同一会话内 data 完全相同，第 2 份起不产生任何新信息
 *   big-text / big-thinking / big-toolcall  老轮次里的大块：留头尾，中间标「已折叠」
 */
import { createReadStream, writeFileSync, copyFileSync, mkdirSync, statSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import readline from "node:readline";

export const KIND = {
  BAD_LINE: "bad-line",
  ZERO_TOKEN: "zero-token",
  DUP_SYSTEM: "dup-system",
  DANGLING_EDIT: "dangling-edit",
  DUP_IMAGE: "dup-image",
  BIG_TEXT: "big-text",
  BIG_THINKING: "big-thinking",
  BIG_TOOLCALL: "big-toolcall",
  // 语义类（2026-11-25 移植：LobeHub / Claude Code 会话恢复的三条过滤器，按 pi 的结构改写）
  UNRESOLVED_TOOLCALL: "unresolved-toolcall",  // toolCall 无对应 toolResult（摘块，不删条目）
  THINKING_ONLY: "thinking-only",              // 只有思考、无正文无工具调用、无兄弟可合并
  WS_ONLY: "whitespace-only",                  // 只有空白文本
  // 悬空父指针：parentId 指向一个本文件里不存在的 id。
  // 2026-11-26 实测：一条 assistant 的 parentId 指向从没落盘的 id，leaf 往回走一步就停住，
  // 前端只渲染断点之后的 9 轮 —— 前面 4000 多条 entry 还在文件里，却看不见。
  // 修法是接链（改 parentId），一个字节也不删。
  BROKEN_LINK: "broken-link",
  // 思考块上的 API 签名（Anthropic 协议要求回传，OpenAI 兼容协议完全忽略）。
  // 2026-11-26 实测：单条几十到几百字节，累积到几 MB，对 openai-completions 无任何作用。
  // 反例：anthropic provider 的会话清掉签名，下一轮请求会被上游 400 拒 —— 所以只清字段，不删块。
  // 图片上限（2026-11-26 实测）：上游对单次请求里的图片数有硬上限（magpie 的 group/never-stuck 是 20 张）。
  // 超过就 400「Total number of images exceeds the maximum allowed of 20.」——
  // 而 pi 每次请求都带整条链的历史，所以一旦链上累计超过上限，这个会话**永久卡死**：
  // 每一轮都 400，连「删掉最后一条图」都发不出去（请求先失败，模型根本没有机会回话）。
  // 判定口径：只数**当前链**（leaf 往 root 走的那条），因为请求只发链上的内容。
  IMAGE_OVERFLOW: "image-overflow",
  THINKING_SIGNATURE: "thinking-signature",
  // 上下文改写账本（2026-11-26 用户实测：一个插件给**每条** assistant 追加一条
  // 「去掉 thinking 的整条 content 复制」，14.9 万条、305MB，占该文件 87%）。
  // 它不携带任何新对话内容，只是同一条消息的第二份拷贝 —— 删了对话一个字不丢，
  // 只是模型下一轮会重新看到 thinking（append-only 账本被撤掉的效果）。
  CONTEXT_EDIT: "context-edit-dup",
  // 同一 target 的多条改写账本里，只有**最后一条**生效（append-only 覆盖）。
  // 前面每一条都被后一条顶掉，永远不参与构建上下文 —— 删掉不改变任何语义。
  // 2026-11-26 实测：某会话 478 个 target、平均每个被写 275 次。
  CONTEXT_EDIT_STALE: "context-edit-stale",
};

/** 删除类：整条 entry 从文件里去掉。 */
export const REMOVABLE = [KIND.ZERO_TOKEN, KIND.DUP_SYSTEM, KIND.DANGLING_EDIT, KIND.THINKING_ONLY, KIND.WS_ONLY, KIND.CONTEXT_EDIT, KIND.CONTEXT_EDIT_STALE];
/** 摘块类：只去掉命中的块，条目本身留下（pi 的 assistant 一条里同时有 thinking/text/toolCall）。 */
export const STRIPPABLE = [KIND.UNRESOLVED_TOOLCALL];
/** 折叠类：块内内容缩成「头 + 尾 + 标记」，块本身保留（结构不变）。 */
export const FOLDABLE = [KIND.DUP_IMAGE, KIND.IMAGE_OVERFLOW, KIND.BIG_TEXT, KIND.BIG_THINKING, KIND.BIG_TOOLCALL];
/** 接链类：不删字节，只改 parentId，把悬空的条目接回它在时间上的前一条。 */
export const RELINKABLE = [KIND.BROKEN_LINK];
/** 清字段类：块留下，只删其中的一个字段（thinking 正文一字不动）。 */
export const CLEANABLE = [KIND.THINKING_SIGNATURE];

export const DEFAULTS = {
  keepTurns: 30,     // 最近 N 轮不折叠
  minBytes: 10240,   // 折叠门槛
  head: 3000, tail: 800,
  headThink: 1500, tailThink: 400,
  foldImages: "dup", // dup | all | none
  // 单次请求允许的图片张数。上游报错原文写 20，所以默认 20；
  // 换供应商时改这里（或 opts.maxImages），判定与执行都用这一个数。
  maxImages: 20,
};

/** 1×1 透明 PNG（95 字节）。占位图，pi 照常渲染。 */
export const DOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 读一个会话文件：原样保留每行字符串（未改动的行写回时逐字节不变）。 */
export async function readSession(file) {
  const lines = [];
  const rl = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) lines.push(line);
  const entries = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
  return { lines, entries };
}

const fp = (value) => createHash("md5").update(JSON.stringify(value)).digest("hex");
const isEmptyContent = (c) =>
  c === null || c === undefined || (Array.isArray(c) && c.length === 0) || (typeof c === "string" && !c.trim());
const bytesOf = (s) => Buffer.byteLength(s, "utf8");
const clip = (s, n = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** 当前链：从最后一条（leaf）沿 parentId 回溯到 root，返回下标数组（按时间顺序）。
 *  为什么按 leaf 回溯而不按文件顺序：文件是 append-only 的，被废弃的分支也在里面。
 *  请求只发当前链 —— 数图片与判脱链必须用同一条链，否则判的与发的是两件事。
 *  断链时就停在那儿：后面接不上，能数多少算多少（不许因此抛错）。
 */
export function chainOf(entries) {
  const byId = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e && typeof e.id === "string") byId.set(e.id, i);
  }
  const chain = [];
  const seen = new Set();
  let cur = entries.length - 1;
  while (cur >= 0 && cur < entries.length) {
    const e = entries[cur];
    if (!e || typeof e.id !== "string" || seen.has(e.id)) break;
    seen.add(e.id);
    chain.push(cur);
    const p = e.parentId;
    if (typeof p !== "string" || !p) break;
    const next = byId.get(p);
    if (next === undefined) break;
    cur = next;
  }
  return chain.reverse();
}
/** 从尾部数 keepTurns 个 user 消息，它之前的一律算「老轮次」（可折叠）。 */
export function cutoffIndex(entries, keepTurns) {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.message?.role === "user") {
      seen += 1;
      if (seen >= keepTurns) return i;
    }
  }
  return 0;
}

/**
 * 认异常。返回的每条都带 entry（条目下标）与 block（content 内下标，删除类为 null），
 * 以及 bytes（能省多少）与 why（一句话说清为什么它不是内容）。
 */
/**
 * 建索引：一次扫完，产出判定段只读的全部预计算。
 *
 * 为什么抽成函数（2026-11-27）：组 2 的判据「两段共享可变结构就不是两段」。
 * 抽出来之后「建」与「用」在代码上是两个函数，check-index-readonly.mjs 才站得住——
 * 它让「判定段写索引」变成可静态检查的，而不是只能靠人盯着循环体。
 *
 * 返回的 Map/Set 调用方只读。它们本身不可变吗？不——freeze 对 Map 无效
 * （见 check-index-readonly.mjs 顶部的最小复现），保护来自那条静态判据，不来自运行时。
 *
 * 除索引外还返回派生值（如 deadCalls）：它由 callIds 与 resultIds 算出一次，
 * 判定段只读。留在判定段算会变成「每类异常各算一遍」，那是两段共享计算的形状。
 */
export function buildIndexes(entries, o) {
  // 先建 id 索引：悬空判定要用完整集合；entryById 给「上下文改写账本」比对目标内容用。
  const ids = new Set();
  const entryById = new Map();
  for (const e of entries) if (e && typeof e.id === "string") { ids.add(e.id); entryById.set(e.id, e); }

  // 每个 target 的**最后一条** context_edit 下标。context_edit 是 append-only 覆盖：
  // 读的时候取最后一条，前面的每条都被后来者顶掉，永远不进上下文。
  const lastEditIdx = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e?.type === "context_edit" && typeof e.targetId === "string") lastEditIdx.set(e.targetId, i);
  }

  // 每种 system 内容的最后一次出现（保留最后一份）。
  const lastSystem = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e?.type === "message" && e?.message?.role === "system") lastSystem.set(fp(e.message.sections ?? e.message.content ?? null), i);
  }


  // ── 工具闭环（移植自 Claude Code / LobeHub 会话恢复的 filterUnresolvedToolUses）──
  // 扫所有 toolCall.id 与 toolResult 的 toolCallId，差集就是死调用。
  // **pi 与 Claude Code 的结构差异决定了动作不同**：Claude Code 里 tool_use 独占一条消息，
  // 所以它整条删；pi 的 assistant 一条里同时有 thinking + text + toolCall（实测 22 条样本
  // 全是 thinking+text+toolCall），整条删会丢真实正文。所以这里只**摘块**，保留其它块。
  const callIds = new Set();
  const resultIds = new Set();
  for (const e of entries) {
    const m = e?.message;
    if (!m) continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === "toolCall" && typeof b.id === "string") callIds.add(b.id);
    }
    if (m.role === "toolResult" && typeof m.toolCallId === "string") resultIds.add(m.toolCallId);
  }
  const deadCalls = new Set([...callIds].filter((id) => !resultIds.has(id)));

  // 同一条 assistant 的兄弟：判断「thinking-only 是否孤立可用合并」。
  const assistantsByParent = new Map();
  for (const e of entries) {
    if (e?.message?.role !== "assistant") continue;
    const p = typeof e.parentId === "string" ? e.parentId : "(root)";
    if (!assistantsByParent.has(p)) assistantsByParent.set(p, []);
    assistantsByParent.get(p).push(e);
  }
  // 每张图首次出现的 (entry, block)。预先算好，判定时只读。
  //
  // 为什么是「预先算」而不是「边扫边记」（2026-11-27）：边扫边记让判定与记账混在
  // 同一个循环里，于是这一类的判决依赖扫描顺序——那正是「拆不开」的形状：
  // 两段共享一个可变结构，就不是两段（组 2 的判据）。
  //
  // 键必须是 (entry, block) 组合，不能只按 entry 下标：同一条 message 里两张相同的图，
  // entry 下标相同，只按 entry 判会把第 2 张当成首次出现而漏报。
  // 边界样本挡着这条：check-anomaly-samples.mjs 的「dup-image 边界」两条。
  const firstImageAt = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const c = entries[i]?.message?.content;
    if (!Array.isArray(c)) continue;
    for (let k = 0; k < c.length; k += 1) {
      const b = c[k];
      if (!b || b.type !== "image" || typeof b.data !== "string" || b.foldedFrom !== undefined) continue;
      const h = createHash("md5").update(b.data).digest("hex");
      if (!firstImageAt.has(h)) firstImageAt.set(h, i + ":" + k);
    }
  }
  return { cut: cutoffIndex(entries, o.keepTurns), ids, entryById, lastEditIdx, lastSystem, callIds, resultIds, deadCalls, assistantsByParent, firstImageAt };
}

export function findAnomalies(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // 两段：算一次，然后只读判定。check-index-readonly.mjs 静态看着这条边界。
  return judgeEntries(entries, o, buildIndexes(entries, o));
}

/**
 * 判定：只读索引与 entries，产出异常清单。不建索引、不写任何共享结构。
 *
 * 为什么单独一个函数（2026-11-27）：这是「拆得开」的第二个证据。
 * 第一个是 buildIndexes，把预计算从判定段拿出去。
 * 现在 findAnomalies 只剩组合：buildIndexes（算一次）到 judgeEntries（只读判定）。
 *
 * 判据是那 34 条坏样本全绿：结构变了、行为没变。
 * 若某个样本从绿变红，说明这两段之间还有没搬干净的共享状态。
 */
export function judgeEntries(entries, o, idx) {
  const { ids, entryById, lastEditIdx, lastSystem, callIds, resultIds, deadCalls, assistantsByParent, firstImageAt, cut } = idx;
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) {
      out.push({ entry: i, block: null, kind: KIND.BAD_LINE, bytes: bytesOf(""), why: "这一行不是合法 JSON，读不出条目" });
      continue;
    }
    const m = e.message ?? {};

    if (e.type === "message" && m.role === "assistant" && isEmptyContent(m.content) && Number(m?.usage?.totalTokens ?? 0) === 0) {
      out.push({ entry: i, block: null, kind: KIND.ZERO_TOKEN, bytes: 0, why: "空 content 且 0 token：失败的模型调用留下的空壳" });
      continue;
    }
    if (e.type === "message" && m.role === "system" && lastSystem.get(fp(m.sections ?? m.content ?? null)) !== i) {
      out.push({ entry: i, block: null, kind: KIND.DUP_SYSTEM, bytes: 0, why: "与后面某条 system 快照内容完全相同（只保留最后一份）" });
      continue;
    }

    // ── context_edit（改写账本）—— 三条判据，按「是否可能生效」排序 ──
    // 为什么这类要单独一组：它是本机最大的会话污染源（实测单文件 12.4 万条 / 305MB / 占 87%），
    // 而它的语义很干净 —— append-only 覆盖，读时取该 target 的**最后一条**。
    // 由此可推出两条无损清理：改不到对象的、被后来者顶掉的。
    if (e.type === "context_edit" && typeof e.targetId === "string") {
      const bytes = bytesOf(JSON.stringify(e));

      // ① 悬空：target 已不存在 → 这条永远不生效。
      // 旧口径只处理 replacement=null（「省略一条不存在的消息」），replacement 有值的悬空留着不报。
      // 2026-11-26 改：两者都不生效，都该清 —— 之前那 54 条一直躺在文件里没人管。
      if (!ids.has(e.targetId)) {
        out.push({
          entry: i, block: null, kind: KIND.DANGLING_EDIT, bytes,
          why: e.replacement === null || e.replacement === undefined
            ? "targetId 已不存在（省略一条不存在的消息，永远不生效）"
            : "targetId 已不存在（改写内容加不到不存在的消息上，永远不生效）",
        });
        continue;
      }

      // ② 中间账本：同一 target 有多条，只有最后一条生效，前面全被顶掉。
      // 这条是无损清理里收益最大的一条：实测某会话 478 个 target、平均每个被写 275 次。
      // 判据在 verify 里（每个存活 target 的最后一条必须原样保留），删错了那边会红。
      if (lastEditIdx.get(e.targetId) !== i) {
        out.push({
          entry: i, block: null, kind: KIND.CONTEXT_EDIT_STALE, bytes,
          why: "同一目标的旧改写账本：只有最后一条生效，这条已被后来者顶掉",
        });
        continue;
      }

      // ③ 复制目标内容（插件 bug 的形状）：replacement 是目标消息的复制，只有 thinking 被**截短**。
      // 判据保守：非 thinking 的块必须逐字节相同、块数一致 —— 真做内容替换的改写不动。
      //
      // 必须再要求「thinking 文本真的变了」（2026-11-26 实测的相反形状）：
      // pi-think-sentry 在 turn_end 写的那条覆盖记录，是「同一条消息、只去掉 thinkingSignature」，
      // 非 thinking 块当然相同、thinking 块也在 —— 与 bug 记录逐字节同形。但它**不是**垃圾：
      // 它就是插件清签名的成果。删掉它，原 assistant 上的签名回来了，模型重新看到它。
      // 所以判据收紧成：thinking 文本不同才算复制品；只差签名字段的，放过。
      const t = entryById.get(e.targetId);
      const repl = e.replacement && e.replacement.content;
      if (t?.message && Array.isArray(repl) && Array.isArray(t.message.content)
        && repl.length === t.message.content.length
        && repl.some((b) => b?.type === "thinking")) {
        const body = (arr) => arr.filter((b) => b?.type !== "thinking");
        const thinkText = (arr) => arr.filter((b) => b?.type === "thinking").map((b) => String(b?.thinking ?? "")).join("\u0000");
        const sameBody = JSON.stringify(body(repl)) === JSON.stringify(body(t.message.content));
        const thinkChanged = thinkText(repl) !== thinkText(t.message.content);
        if (sameBody && thinkChanged) {
          out.push({ entry: i, block: null, kind: KIND.CONTEXT_EDIT, bytes, why: "上下文改写账本：目标消息的复制，只有 thinking 被截短（无新内容）" });
          continue;
        }
      }
    }

    // ── 三条语义过滤器（2026-11-25 移植）──
    // 它们都只在「这一条对上下文零贡献」时动手，且都在 keepTurns 之外才动：
    // 最近 N 轮可能是正在流式写入的，那不算坏数据。
    if (m.role === "assistant" && Array.isArray(m.content) && m.content.length && i < cut) {
      const types = m.content.map((b) => b?.type);
      const onlyThinking = types.every((t) => t === "thinking");
      const onlyWsText = types.every((t) => t === "text") && m.content.every((b) => !String(b.text || "").trim());
      const onlyDeadCalls = types.every((t) => t === "toolCall") && m.content.every((b) => deadCalls.has(b.id));

      if (onlyThinking) {
        // 孤立的 thinking-only：没有同父的兄弟 assistant 带非思考内容可合并（Claude Code 的
        // filterOrphanedThinkingOnlyMessages 判法）。pi 里消息不分片，所以「孤立」= 无兄弟。
        const sibs = assistantsByParent.get(typeof e.parentId === "string" ? e.parentId : "(root)") || [];
        const hasMergeable = sibs.some((s) => s !== e && Array.isArray(s.message?.content) && s.message.content.some((b) => b?.type !== "thinking"));
        if (!hasMergeable) {
          out.push({ entry: i, block: null, kind: KIND.THINKING_ONLY, bytes: 0, why: "只有思考、无正文无工具调用，且没有可合并的兄弟（流式中断的碎片）" });
          continue;
        }
      }
      if (onlyWsText) {
        out.push({ entry: i, block: null, kind: KIND.WS_ONLY, bytes: 0, why: "全部文本块都是空白：模型返回了空正文" });
        continue;
      }
      if (onlyDeadCalls) {
        // 整条只有死调用、没有正文：删条目（与 Claude Code 一致）
        out.push({ entry: i, block: null, kind: KIND.THINKING_ONLY, bytes: 0, why: "只有未闭环的工具调用，无正文" });
        continue;
      }
    }
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const inScope = i < cut && e.type !== "compaction";
    for (let k = 0; k < content.length; k += 1) {
      const b = content[k];
      if (!b || typeof b !== "object") continue;

      // 死调用：这条 assistant 还有正文/思考，只摘掉那个没有 toolResult 的块。
      // 反例（照抄 Claude Code 会踩）：整条删 —— 实测 22 条样本都是 thinking+text+toolCall，
      // 删整条等于删掉模型已经写出来的正文。
      if (b.type === "toolCall" && typeof b.id === "string" && deadCalls.has(b.id)) {
        out.push({ entry: i, block: k, kind: KIND.UNRESOLVED_TOOLCALL, bytes: 0, why: "工具调用没有对应的结果（中断留下的死引用）", preview: String(b.name || "") });
        continue;
      }

      // 已折叠过的占位图不再参与判定（2026-11-25 实测踩到）：折叠把多张图都换成同一个
      // 1×1 PNG，于是它们互相成了「重复」，下一次扫描又会报一遍——处理动作自己制造了
      // 下一轮的处理对象，与 pi-think-sentry 那个越清越多的 bug 同形。用 foldedFrom 认出来。
      if (b.type === "image" && typeof b.data === "string" && o.foldImages !== "none" && b.foldedFrom === undefined) {
        const h = createHash("md5").update(b.data).digest("hex");
        // 只读：不是首次出现的那个 (entry, block) 就是重复。
        const isDup = firstImageAt.get(h) !== i + ":" + k;
        if (o.foldImages === "all" || isDup) {
          out.push({
            entry: i, block: k, kind: KIND.DUP_IMAGE, bytes: b.data.length,
            why: isDup ? "同一张图在这一会话里出现过（第 2 份起无新信息）" : "老轮次的图片（模型早已看过）",
            preview: b.mimeType + " " + Math.round(b.data.length / 1024) + "KB",
          });
        }
        continue;
      }
      if (!inScope) continue;
      if (b.type === "text" && typeof b.text === "string" && bytesOf(b.text) > o.minBytes) {
        out.push({ entry: i, block: k, kind: KIND.BIG_TEXT, bytes: bytesOf(b.text) - bytesOf(b.text.slice(0, o.head) + b.text.slice(-o.tail)), why: "老轮次的长正文（最近 " + o.keepTurns + " 轮之外）", preview: clip(b.text) });
        continue;
      }
      if (b.type === "thinking" && typeof b.thinking === "string" && bytesOf(b.thinking) > o.minBytes) {
        out.push({ entry: i, block: k, kind: KIND.BIG_THINKING, bytes: bytesOf(b.thinking) - bytesOf(b.thinking.slice(0, o.headThink) + b.thinking.slice(-o.tailThink)), why: "老轮次的长思考", preview: clip(b.thinking) });
        continue;
      }
      if (b.type === "toolCall" && b.arguments && typeof b.arguments === "object") {
        const raw = JSON.stringify(b.arguments);
        if (bytesOf(raw) <= o.minBytes) continue;
        const big = Object.entries(b.arguments).filter(([, v]) => typeof v === "string" && bytesOf(v) > o.minBytes);
        if (!big.length) continue;
        out.push({ entry: i, block: k, kind: KIND.BIG_TOOLCALL, bytes: big.reduce((n, [, v]) => n + bytesOf(v), 0), why: "老轮次的超长工具参数（" + big.map(([key]) => key).join(", ") + "）", preview: clip(String(big[0][1])) });
      }
    }
  }
  // 悬空父指针：单独一趟，与块级判定无关。判的是「父指针指向的 id 在不在本文件里」。
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e.id !== "string") continue;
    const p = e.parentId;
    if (typeof p !== "string" || !p) continue;
    if (ids.has(p)) continue;
    out.push({
      entry: i, block: null, kind: KIND.BROKEN_LINK, bytes: 0,
      why: "父指针指向的条目不在本文件里（链在这里断，断点之后的全看不见）",
      preview: "parentId " + p.slice(0, 8) + " 不存在 · " + (e.message?.role ?? e.type),
    });
  }

  // 思考签名：与体量无关，只要带就报（对 openai-completions 是纯冗余字节）。
  for (let i = 0; i < entries.length; i += 1) {
    const c = entries[i]?.message?.content;
    if (!Array.isArray(c)) continue;
    for (let k = 0; k < c.length; k += 1) {
      const b = c[k];
      if (!b || b.type !== "thinking") continue;
      const sig = b.thinkingSignature;
      if (typeof sig !== "string" || !sig) continue;
      out.push({
        entry: i, block: k, kind: KIND.THINKING_SIGNATURE, bytes: bytesOf(sig),
        why: "思考块的 API 签名（Anthropic 协议才需要；openai-completions 忽略）",
        preview: sig.slice(0, 24) + (sig.length > 24 ? "…" : "") + " · " + bytesOf(sig) + "B",
      });
    }
  }

  // 链上图片超上限：只数当前链（请求只发链上的内容）。
  // 为什么这条不能归进「省空间」那一组：它不是体量问题，是「这个会话根本发不出去」。
  // 上游对单次请求的图片张数有硬上限（实测 20 张），超了每轮都 400；
  // 而界面上看不出任何异常 —— 会话还在、消息还在，只是发不出去。
  const imgCap = Number.isFinite(o.maxImages) ? o.maxImages : DEFAULTS.maxImages;
  if (imgCap > 0) {
    const imgs = [];
    for (const idx of chainOf(entries)) {
      const c = entries[idx]?.message?.content;
      if (!Array.isArray(c)) continue;
      for (let k = 0; k < c.length; k += 1) {
        const b = c[k];
        if (!b || b.type !== "image" || typeof b.data !== "string") continue;
        // 已折过的占位图不算：它已经是一张极小图，再折一次没有意义。
        if (b.foldedFrom !== undefined) continue;
        imgs.push({ entry: idx, block: k, bytes: b.data.length });
      }
    }
    if (imgs.length > imgCap) {
      // 留最新 imgCap 张（最近这几轮最可能是人正在看的），多出来的从最老的开始折。
      const over = imgs.slice(0, imgs.length - imgCap);
      for (let n = 0; n < over.length; n += 1) {
        const x = over[n];
        out.push({
          entry: x.entry, block: x.block, kind: KIND.IMAGE_OVERFLOW, bytes: x.bytes,
          why: "链上图片 " + imgs.length + " 张，超过单次请求上限 " + imgCap + " 张：每轮请求都 400，会话永久卡死",
          preview: "第 " + (n + 1) + "/" + imgs.length + " 张（最老的一批）",
        });
      }
    }
  }
  return out;
}


/** 结构判据：不满足就说明这一步改动坏了文件，调用方必须拒绝写盘。 */
export function measure(lines) {
  let bad = 0; let users = 0; let asst = 0; let last = null; let sig = 0;
  // 图片带 id：链上算要求「这张图在哪条链上」，光有总数分不出分支。
  const liveImages = [];
  const sigIds = new Set();
  // thinking 块总数：清签名只许动字段，不许动块。2026-11-26 事故就是块被整块摘掉，
  // 而当时没有任何判据看这个数。
  let thinkBlocks = 0;
  // 链上「还会进请求」的图片张数（已折成占位的折叠图不算）。
  // 相邻 user（链上直接相邻）：API 要求 user/assistant 交替，连续两条 user 会让请求 400。
  let adjacentUsers = 0;
  let prevUser = null;
  const childIds = new Map();
  const roots = [];
  const ids = new Set(); const parents = []; const targets = [];
  // 每个 target 最后一条 context_edit 的指纹（后写覆盖 = 天然「最后一条」）。
  // 用途：verify 判「清理之后，每个存活 target 的生效内容一字未变」——
  // 这是 context_edit 清理的**唯一**正确性判据，比条数对比强。
  const editFp = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { bad += 1; continue; }
    if (typeof e.id === "string") { ids.add(e.id); last = e.id; }
    if (typeof e.parentId === "string") parents.push(e.parentId);
    if (e.type === "context_edit" && typeof e.targetId === "string") { targets.push(e.targetId); editFp.set(e.targetId, fp(e.replacement ?? null)); }
    const m = e.message ?? {};
    const c = m.content;
    // 折叠图（带 foldedFrom）不算：它已经变成一行文字，不会再进请求。
    const empty = isEmptyContent(c);
    if (Array.isArray(c)) for (const b of c) if (b && b.type === "image" && typeof b.data === "string" && b.foldedFrom === undefined) liveImages.push(e.id);
    if (Array.isArray(c)) for (const b of c) if (b && b.type === "thinking") thinkBlocks += 1;
    if (Array.isArray(c) && c.some((b) => b && b.type === "thinking" && typeof b.thinkingSignature === "string" && b.thinkingSignature)) { sig += 1; if (typeof e.id === "string") sigIds.add(e.id); }
    if (m.role === "user") {
      users += 1;
      // 链上直接相邻：这一条的 parentId 正好是上一条 user 的 id
      if (prevUser && typeof e.parentId === "string" && e.parentId === prevUser) adjacentUsers += 1;
      prevUser = typeof e.id === "string" ? e.id : null;
    } else if (m.role === "assistant") {
      if (!empty) asst += 1;
      prevUser = null;
    } else {
      prevUser = null;
    }
    if (typeof e.id === "string") {
      const p = typeof e.parentId === "string" ? e.parentId : null;
      if (p === null) roots.push(e.id);
      else {
        if (!childIds.has(p)) childIds.set(p, []);
        childIds.get(p).push(e.id);
      }
    }
  }
  return {
    n: lines.length, bad, users, asst, last, ids: ids.size, idSet: ids, adjacentUsers, sig, sigIds, thinkBlocks,
    // 链上未折叠的图片张数：判「这次请求会不会被上游 400 挡掉」用的就是它。
    chainImages: (() => {
      const onChain = new Set();
      const es = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
      for (const idx of chainOf(es)) { const e = es[idx]; if (e && typeof e.id === "string") onChain.add(e.id); }
      return liveImages.filter((id) => onChain.has(id)).length;
    })(),
    orphan: parents.filter((p) => !ids.has(p)).length,
    // 悬空的只算**target 存在性**：指向不存在条目的 edit 不生效，删它不改语义。
    dangling: targets.filter((t) => !ids.has(t)).length,
    // 只保留「target 仍存在」的那些 —— 它们的最后一条 edit 是真正生效的内容。
    lastEditFp: (() => {
      const m = new Map();
      for (const [t, h] of editFp) if (ids.has(t)) m.set(t, h);
      return m;
    })(),
    dangling: targets.filter((t) => !ids.has(t)).length,
    unreachable: (() => {
      if (!roots.length) return 0;
      const seen = new Set();
      const stack = [...roots];
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const c of childIds.get(id) || []) stack.push(c);
      }
      return ids.size - seen.size;
    })(),
  };
}

/**
 * 结构判据。expect 是可选的「预期减少量」——语义清理（thinking-only / ws-only / 死调用条目）
 * 与 user 合并**必然**减少条数，那不是损坏。不给 expect 时按「一条都不许少」判。
 *
 * 反例（2026-11-25 实测）：不给 expect 就用「user 条数不变」判，于是任何一次真实合并都红，
 * 红的理由却是「你删了东西」——判据把正当动作当成缺陷，人只能学会忽略它。
 */
export function verify(before, after, expect = {}) {
  const checks = [
    ["坏行", after.bad === 0, after.bad],
    // 这两条判的是「本次动作没造出新的死引用」，不是「文件里一条都没有」。
    // 旧口径写的是 === 0，于是任何原本就带死引用的文件、执行任何动作都被拒绝写盘。
    // 2026-11-25 实测：会话 2026-11-20T00-42-25-558Z 有 100526 条 context_edit、其中 54 条本来
    // 就指向不存在的 targetId（另一条写入路径留下的，与清理无关），结果连「删一条空壳」都被拒。
    // 判据把既有缺陷算到本次动作头上，人就只能学会忽略它。
    // thinking 块数（2026-11-26 事故补，同日第二次改口径）。
    // 事故：摘块函数不看 kind，把清签名那批当成摘块目标，17 个会话 22024 个 thinking 块被整块摘光；
    // 而当时只数签名 —— 签名确实归零，所以判据一路绿灯。块数是唯一能看出这件事的数。
    // 为什么不是「块数完全不变」：删「孤立思考」是**设计好的**删除（只有思考、无正文无工具调用的碎片），
    // 删它必然少一个块。写死 === before 会把合法删除判红（实测 1103 → 1102，一个文件被拒写盘）。
    // 正确口径：下降量 == 被删条目里带的块数。多降的才是事故。
    ["thinking 块数下降量 == 被删条目里的块数",
      before.thinkBlocks - after.thinkBlocks === (expect.thinkRemoved ?? 0),
      before.thinkBlocks + " → " + after.thinkBlocks + "，删掉的条目里带 " + (expect.thinkRemoved ?? 0) + " 块"],
    // 链上图片必须降到上限内（2026-11-26 事故补）。
    // 这条判的是「这次动作有没有真的把会话救回来」：折了 N 张但仍有 25 张，
    // 请求照样 400 —— 只数「折了几张」的判据会一路绿灯而会话依旧发不出去。
    // 反例：applyFold 的 byKey 用 a.entry + ":" + a.block 定位，若下标错位就折错了图，
    // 折的条数对得上、链上图片数却没降 —— 只有这条抓得到。
    // 口径按「本次动作做过折图吗」分（2026-11-26 实测两处都要用同一条判据）：
    //   折过（expect.foldsImages）→ 必须降到上限内，否则会话仍旧发不出去；
    //   没折（命令行 pruner 只删不折）→ 只判不新增，否则任何一个超限会话都永远 FAIL，
    //     而它根本没被要求做这件事。这与「悬空 parentId 不新增」是同一种形状。
    ["链上图片" + ((expect.foldsImages ?? (expect.maxImages !== undefined)) ? " <= 上限" : "不新增"),
      (expect.foldsImages ?? (expect.maxImages !== undefined))
        ? after.chainImages <= (expect.maxImages ?? DEFAULTS.maxImages)
        : after.chainImages <= before.chainImages,
      before.chainImages + " → " + after.chainImages + "，上限 " + (expect.maxImages ?? DEFAULTS.maxImages)],
    ["悬空 parentId 不新增", after.orphan <= before.orphan, before.orphan + " → " + after.orphan],
	// 清签名（2026-11-26 第三次改）。为什么不能只判「签名总数下降量 == 选中数」：
	// 同一个条目可能同时被判为「孤立思考」（删除类）—— 它被删时签名也一起消失，
	// 于是总数下降量大于清掉的条数，判据把「删对了」判成红。三个文件就这样被挡住写不进去。
	// 两条判据，都带「没传 cleanIds 就退回数量口径」的退路 —— 不传不是错，是另一种调用方。
	//   ① 清掉的数不超过选中数（传了 cleanIds 才有意义）；
	//   ② 逐条核对：选中且在结果里仍存活的，不得再带签名。
	// 反例：applyClean 顺手把整个 thinking 块也删了 —— 条数对得上，正文却丢了，由「正文不变」那条兜。
	["清签名不超过选中数",
		expect.cleanIds === undefined ? (expect.cleaned ?? 0) >= 0 : (expect.cleaned ?? 0) <= expect.cleanIds.length,
		"清 " + (expect.cleaned ?? 0) + (expect.cleanIds === undefined ? "（未传选中集）" : " / 选中 " + expect.cleanIds.length)],
	["选中的条目清完不再带签名",
		expect.cleanIds === undefined ? before.sig - after.sig === (expect.cleaned ?? 0) : expect.cleanIds.every((id) => !after.idSet.has(id) || !(after.sigIds ?? new Set()).has(id)),
		expect.cleanIds === undefined ? before.sig + " → " + after.sig : String(expect.cleanIds.filter((id) => after.idSet.has(id) && (after.sigIds ?? new Set()).has(id)).length) + " 条还带着"],
    // 接链判据（2026-11-26）：选了 N 条接链，悬空数必须正好降 N。
    // 反例：接错父（把节点接到自己的后代上）会成环 —— 环由 measure().unreachable 兜：
    // 那条统计量从根做可达性遍历，成环的节点走不到，数会涨；本行只管悬空归零。
    // 曾写「由 unreachable 判据兜」：KIND.UNREACHABLE 那个异常类从未实现，2026-11-27 已删。
    // 注释指向一个不存在的东西，比没有注释更坏——读的人会以为已有保护。
    ["悬空减少量 == 接链数 + 删掉的悬空条目数",
      before.orphan - after.orphan === (expect.relinked ?? 0) + (expect.orphansDropped ?? 0),
      before.orphan + " → " + after.orphan + "，接链 " + (expect.relinked ?? 0) + " + 删悬空 " + (expect.orphansDropped ?? 0)],
    ["悬空 context_edit 不新增", after.dangling <= before.dangling, before.dangling + " → " + after.dangling],
    // 链尾判据只挡「原链尾还在、却不再是最后一条」——那说明行序被打乱，或东西被插到它后面。
    // 原链尾被删掉时链尾必然前移（删的就是最后一条），那不是损坏：user / assistant 条数已另判。
    ["链尾顺序不变", after.last === before.last || !after.idSet.has(before.last), before.last + " → " + after.last],
    ["user 条数只减不增", after.users <= before.users, before.users + " → " + after.users],
    ["user 减少量 == 合并数", before.users - after.users === (expect.usersMerged ?? 0), (before.users - after.users) + " vs " + (expect.usersMerged ?? 0)],
    ["assistant 减少量 == 语义删除数", before.asst - after.asst === (expect.asstRemoved ?? 0), (before.asst - after.asst) + " vs " + (expect.asstRemoved ?? 0)],
    ["assistant 条数只减不增", after.asst <= before.asst, before.asst + " → " + after.asst],
    // 新增两条（2026-11-25 移植时补的）：清理不能把会话改成另一个坏形状。
    // 连续两条 user 会让 API 400；不可达条目等于从主链上掉出去，界面上再也看不到。
    // 「无相邻 user」同样按「不新增」判（2026-11-26 第三次同型）。
    // 反例：文件本来就有相邻 user（历史执行留下的），删 context_edit 不会改变它，
    // 但 === 0 的口径让这些文件**永远**红，于是清理跑不动。
    // 该红的是「本次动作造出了新的相邻 user」（删了中间一条导致两条 user 挨上）。
    ["无相邻 user（不新增）", after.adjacentUsers <= before.adjacentUsers, before.adjacentUsers + " → " + after.adjacentUsers],
    // 「可达」同样按「不新增」判。
    // 反例（2026-11-26 实测）：会话 2026-11-20T00-42-25-558Z（340MB / 131750 行）本来就有 7361 条
    // 不可达 —— 那是历史 compaction 把老轮次从主链上切下去留下的，与清理无关。
    // 旧口径写 === 0，于是这个文件**永远**被拒：「这几个一直成功不了」。
    // 真正该红的是「本次动作让更多人掉出主链」（删了中间一条却不重连它的孩子）。
    ["全部条目可达（不新增）", after.unreachable <= before.unreachable, before.unreachable + " → " + after.unreachable],
    // context_edit 清理的**唯一**正确性判据：每个存活 target 的生效内容一字未变。
    // 为什么必须是这一条（而不是「条数减少」）：append-only 覆盖的语义是「取最后一条」，
    // 所以只允许删被顶掉的与被悬空的。删错了最后一条，模型看到的历史就变了，
    // 而条数看起来完全正常 —— 那种坏法条数判据永远抓不到。
    // 反例（本条会红的情形）：把 stale 的判据写成「保留第一条，删后面的」。
    (() => {
      const b = before.lastEditFp || new Map();
      const a = after.lastEditFp || new Map();
      const lost = [];
      for (const [t, h] of b) {
        const got = a.get(t);
        if (got !== h) lost.push(t.slice(0, 8) + (got ? "(改了)" : "(没了)"));
      }
      const want = expect.editsRevoked ?? 0;
      const ok = lost.length === want;
      return ["存活 target 的最后一条改写不变", ok,
        lost.length ? lost.slice(0, 3).join(",") + "（有意撤销 " + want + " 条）" : b.size + " 个全等"];
    })(),
  ];
  return { ok: checks.every(([, pass]) => pass), checks };
}

/** 删除类：去掉命中的条目，并把指向它们的 parentId 接回最近未删祖先。 */
/**
 * 摘块：把命中的块从 content 里去掉，条目本身留下。
 *
 * 为什么不能并进 applyRemoval：那条路径动的是**行**，这条动的是**块**。
 * 两件事混在一个函数里，「删了 3 条」这句话就同时指两种东西，报数会骗人。
 *
 * 摘空的处理：content 变成空数组时，这条消息对上下文零贡献，但**不在这里删**——
 * 那会让「块级操作」变成「条目级操作」，又混回去了。留给下一轮 pruneAll 的
 * zero-token / thinking-only 判据去认（它看的是空 content，能认出来）。
 */
export function applyStripBlocks(lines, entries, chosen) {
  const byKey = new Map();
  for (const a of chosen) {
    // 必须按 kind 过滤，不能只看「有没有块下标」。
    // 2026-11-26 事故：清签名（thinking-signature）的每条异常都带 block 下标，
    // 于是它们全进了 byKey，这个函数把 17 个会话、共 22024 个 thinking 块整块摘掉 ——
    // 而 verify 那时只数「签名总数」，签名确实归零，写盘一路绿灯。
    // 判据补在 verify 的「thinking 块数不变」与 check-clean-signature 的坏样本里。
    if (a.block === null || !STRIPPABLE.includes(a.kind)) continue;
    byKey.set(a.entry + ":" + a.block, a);
  }
  if (!byKey.size) return { lines, stripped: 0, emptied: 0 };
  const out = [];
  let stripped = 0;
  // 摘空的 assistant：它从「有内容 assistant」计数里消失，but 不是被删条目。
  // 不单独数它，「assistant 减少量 == 语义删除数」就恒不平（2026-11-25 实测 3 vs 2）。
  let emptied = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const content = e?.message?.content;
    if (!e || !Array.isArray(content)) { out.push(lines[i]); continue; }
    let changed = false;
    const kept = [];
    for (let k = 0; k < content.length; k += 1) {
      if (byKey.has(i + ":" + k)) { stripped += 1; changed = true; continue; }
      kept.push(content[k]);
    }
    if (!changed) { out.push(lines[i]); continue; }
    e.message.content = kept;
    if (!kept.length && e.message.role === "assistant") emptied += 1;
    out.push(JSON.stringify(e));
  }
  return { lines: out, stripped, emptied };
}

/** 清字段：只删 thinking 块上的 thinkingSignature，thinking 正文与其它字段逐字节不变。
 *  2026-11-26：这些签名对 openai-completions 无作用，纯占体积；对 anthropic 协议是必需的，
 *  所以它单独一类、单独一个勾选框 —— 要清的人自己勾，别混进「删/折」里。 */
export function applyClean(lines, entries, chosen) {
  const picked = chosen.filter((a) => CLEANABLE.includes(a.kind));
  if (!picked.length) return { lines, cleaned: 0, seen: 0, missing: 0 };
  const want = new Set();
  for (const a of picked) {
    const e = entries[a.entry];
    if (e && typeof e.id === "string") want.add(e.id);
  }
  if (!want.size) return { lines, cleaned: 0, seen: 0, missing: 0 };
  let cleaned = 0; let seen = 0;
  const out = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { out.push(line); continue; }
    if (!e || typeof e.id !== "string" || !want.has(e.id) || !Array.isArray(e.message?.content)) { out.push(line); continue; }
    seen += 1;
    let hit = false;
    for (const b of e.message.content) {
      if (b && b.type === "thinking" && typeof b.thinkingSignature === "string" && b.thinkingSignature) {
        delete b.thinkingSignature;
        hit = true;
      }
    }
    if (!hit) { out.push(line); continue; }
    cleaned += 1;
    out.push(JSON.stringify(e));
  }
  // seen = 选中条目在本次读到的文件里出现了几个；missing = 选中了却找不到的条数。
  // 2026-11-26 实测：判据只报「清 0」时无法区分「没清」与「选中条目已被别的规则删掉」，
  // 人只能猜。把这两个数报出来，红的时候原因就在眼前。
  return { lines: out, cleaned, seen, missing: want.size - seen };
}

/** 接链：不删任何字节，只把悬空条目的 parentId 指回「时间上紧邻的前一条」。
 *  选父规则：按 timestamp 排序，从它前一条往回找第一条既不是它自己、也不是它后代的条目（防成环）。
 *  找不到就跳过 —— 宁可不修，也不凭空造一个父。
 *  2026-11-26 的真实案例：b328427f 从未落盘，c8124b80 悬空；接回 22c856c8 后分支长 523 → 5703。 */
export function applyRelink(lines, entries, chosen) {
  const picked = chosen.filter((a) => RELINKABLE.includes(a.kind));
  if (!picked.length) return { lines, relinked: 0, skipped: 0 };
  const byIndex = new Map(entries.map((e, i) => [i, e]));
  const ids = new Set();
  for (const e of entries) if (e && typeof e.id === "string") ids.add(e.id);
  const parentOf = new Map();
  for (const e of entries) if (e?.id) parentOf.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
  const order = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e && typeof e.id === "string" && typeof e.timestamp === "string") order.push({ e, i });
  }
  order.sort((a, b) => (a.e.timestamp < b.e.timestamp ? -1 : a.e.timestamp > b.e.timestamp ? 1 : a.i - b.i));
  const posOf = new Map(order.map((x, k) => [x.e.id, k]));

  const isSelfOrAncestor = (candId, nodeId) => {
    let cur = candId; let guard = 0;
    while (cur && guard < 1000000) {
      if (cur === nodeId) return true;
      cur = parentOf.get(cur) ?? null; guard += 1;
    }
    return false;
  };

  const want = new Set();
  for (const a of picked) {
    const e = byIndex.get(a.entry);
    if (e && typeof e.id === "string") want.add(e.id);
  }

  let relinked = 0; let skipped = 0;
  const out = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { out.push(line); continue; }
    if (!e || typeof e.id !== "string" || !want.has(e.id)) { out.push(line); continue; }
    const p = e.parentId;
    if (typeof p !== "string" || !p || ids.has(p)) { out.push(line); continue; }
    const k = posOf.get(e.id);
    let next = null;
    if (k !== undefined) {
      for (let j = k - 1; j >= 0; j -= 1) {
        const cand = order[j].e.id;
        if (cand === e.id) continue;
        if (isSelfOrAncestor(cand, e.id)) continue;
        next = cand; break;
      }
    }
    if (!next) { skipped += 1; out.push(line); continue; }
    e.parentId = next;
    relinked += 1;
    out.push(JSON.stringify(e));
  }
  return { lines: out, relinked, skipped };
}

export function applyRemoval(lines, entries, chosen) {
  const drop = new Set(chosen.filter((a) => a.block === null && REMOVABLE.includes(a.kind)).map((a) => a.entry));
  // 被删条目里「parentId 本来就指向不存在的 id」的条数。
  //
  // 为什么要有（2026-11-27 实测到的真缺陷）：verify 的「悬空减少量 == 接链数」
  // 假设只有接链能降悬空。但删掉一条**本身就是悬空**的条目，悬空也会降。
  // 某会话里 broken-link 与 zero-token 是同一条 assistant：删它悬空 1 → 0 而 relinked 0，
  // 判据报红。那不是代码坏，是判据的口径漏了一个合法的减少来源。
  //
  // 在函数末尾按 drop 算一次，不依赖循环顺序——中途插入的计数很容易放错位置。
  const allIdsOf = new Set(entries.map((e) => e?.id).filter((x) => typeof x === "string"));
  let orphansDropped = 0;
  for (const i of drop) {
    const e = entries[i];
    if (typeof e?.parentId === "string" && e.parentId && !allIdsOf.has(e.parentId)) orphansDropped += 1;
  }

  if (!drop.size) return { lines, removed: 0, rewired: 0, asstRemoved: 0, usersRemoved: 0, cascadedEdits: 0, thinkRemoved: 0, orphansDropped: 0 };

  const targetOfDropped = new Set();
  const idOfDropped = new Set();
  for (const i of drop) {
    const e = entries[i];
    if (typeof e?.id === "string") idOfDropped.add(e.id);
    if (e?.type === "context_edit" && typeof e.targetId === "string") targetOfDropped.add(e.targetId);
  }

  // 级联**必须在建 parentOfDropped 之前**定下来：被级联删掉的 context_edit 自己也是链上的一环，
  // 别人可能拿它当 parentId。2026-11-25 实测：先把它们放在重连之后再删，14 万条那个文件
  // 一次留下 534 条悬空 parentId —— 「删了之后才决定删谁」，被删者的孩子就没人接了。
  // 每个 target 的**最后一条** edit 的 id：级联删除必须绕开它们。
  // 反例（2026-11-26 实测，新增的 verify 判据第一次跑就抓到）：
  // 某 target 的三条 edit 里最后一条恰好 targetId 指向一个被删条目，于是它被级联删掉，
  // 生效内容从「第三条」退回「第二条」—— 文件行数正常、条数正常，模型看到的历史却变了。
  // 那种坏法只有「存活 target 的最后一条改写不变」判据抓得到。
  const lastEditIdOf = new Map();
  for (const e of entries) {
    if (e?.type === "context_edit" && typeof e.targetId === "string" && typeof e.id === "string") lastEditIdOf.set(e.targetId, e.id);
  }
  let cascadedEdits = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (drop.has(i)) continue;
    const e = entries[i];
    // 只删 targetId 指向**本次被删掉的**条目的 context_edit（确定的死引用）；
    // 原本就悬空的那些不归本次动作负责，保留给人看。
    if (e?.type === "context_edit" && typeof e.targetId === "string" && idOfDropped.has(e.targetId)) {
      // 为什么不额外保护「某个存活 target 的最后一条」：
      // 一条 edit 只有一个 targetId，所以「某 target 的最后一条」就是「targetId 等于它的那一条」。
      // 若要它同时指向被删条目，就必须 targetId 既等于该 target 又指向被删条目 —— 不可能。
      // 换句话说：级联删除永远碰不到存活 target 的最后一条。2026-11-26 试过加保护，坏样本证不出它会红，
      // 按「未被引用的删」去掉；真正的兜底是 verify 的「存活 target 的最后一条改写不变」。
      drop.add(i);
      if (typeof e.id === "string") idOfDropped.add(e.id);
      cascadedEdits += 1;
    }
  }

  const parentOfDropped = new Map();
  let asstRemoved = 0;
  let usersRemoved = 0;
  // 被删条目里的 thinking 块数。删「孤立思考」这类整条消息，块必然少一个 ——
  // verify 的「thinking 块数不变」要把这部分算进去，否则合法删除会被判红（2026-11-26 实测 1103 → 1102）。
  let thinkRemoved = 0;
  for (const i of drop) {
    const e = entries[i];
    if (typeof e?.id === "string") parentOfDropped.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
    // 只数**有内容**的 assistant：空壳本来就没进 asst 计数，数它会让「减少量 == 语义删除数」恒不平。
    if (e?.message?.role === "assistant" && !isEmptyContent(e.message.content)) asstRemoved += 1;
    if (e?.message?.role === "user") usersRemoved += 1;
    if (Array.isArray(e?.message?.content)) for (const b of e.message.content) if (b?.type === "thinking") thinkRemoved += 1;
  }
  const resolve = (id) => {
    let cur = id; const guard = new Set();
    while (typeof cur === "string" && parentOfDropped.has(cur)) {
      if (guard.has(cur)) return null;
      guard.add(cur); cur = parentOfDropped.get(cur);
    }
    return typeof cur === "string" ? cur : null;
  };
  const out = [];
  let rewired = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (drop.has(i)) continue;
    const e = entries[i];
    if (!e) { out.push(lines[i]); continue; }
    if (typeof e.parentId === "string" && parentOfDropped.has(e.parentId)) {
      e.parentId = resolve(e.parentId);
      rewired += 1;
      out.push(JSON.stringify(e));
    } else out.push(lines[i]);
  }
  // 被删掉的 edit 里，有多少条是「某个**存活** target 的最后一条」= 有意撤销了那次改写。
  // 只数 target 存在的：指向不存在条目的 edit 从来没生效过，删它撤销不了任何东西
  // （口径必须与 measure.lastEditFp 一致，否则两边差一个数就红得没道理 —— 2026-11-26 实测撞到）。
  const entryIds = new Set();
  for (const e of entries) if (e && typeof e.id === "string") entryIds.add(e.id);
  let editsRevoked = 0;
  for (const i of drop) {
    const e = entries[i];
    if (e?.type === "context_edit" && typeof e.targetId === "string"
      && entryIds.has(e.targetId) && lastEditIdOf.get(e.targetId) === e.id) editsRevoked += 1;
  }
  return { lines: out, removed: drop.size, rewired, asstRemoved, usersRemoved, cascadedEdits, editsRevoked, thinkRemoved, orphansDropped };
}

/** 折叠类：块内缩成「头 + 尾 + 标记」，块本身保留。 */
/**
 * 删到不动点：删条目会**新产生**悬空 context_edit（被删的那条正好是某个 edit 的 target），
 * 于是第二轮又多出一条可删的。旧的 prune-session 手写了一版级联，界面那条路径没有，
 * 结果界面上执行后文件里留着 replacement=null 的悬空编辑（2026-11-25 迁移时对拍抓到的）。
 *
 * 轮数上限 5 只是防御：每轮至少删 1 条，正常文件 2 轮就到定点。
 * 返回值里的 cascaded 是「用户没勾、但必须连带删」的条数——界面要把它报出来，
 * 否则人以为只删了 3 条，磁盘上少了 4 条。
 */
/**
 * 合并相邻的 user 消息（移植自 Claude Code filterWhitespaceOnlyAssistantMessages 的后半段）。
 *
 * 为什么必须有这一步：删掉两条提问之间唯一的 assistant，就留下连续两条 user。
 * API 要求 user/assistant 交替，连续两条 user 会让下一次请求直接 400 ——
 * 也就是说「清理」反而把会话弄坏了。Claude Code 在同一个过滤器里紧跟一步 mergeUserMessages，
 * 我第一版漏了这步（2026-11-25 对照源码时发现）。
 *
 * 只合并**链上直接相邻**的：前一条的 id 正好等于后一条的 parentId。
 * 反例（松一点就会踩）：同一次 flush 里的两条 user 在文件里相邻，但在链上是兄弟分支 ——
 * 按文件顺序合并会把两条独立分支并成一条，内容就此串线。
 */
export function mergeAdjacentUsers(lines, entries) {
  const byId = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (typeof e?.id === "string") byId.set(e.id, i);
  }
  const mergedAway = new Set();
  const out = [];
  let merged = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) { out.push(lines[i]); continue; }
    const prev = out.length ? JSON.parse(out[out.length - 1]) : null;
    const bothUser = e?.message?.role === "user" && prev?.message?.role === "user";
    // 链上直接相邻才算同一条提问被拆开
    const chained = bothUser && typeof e.parentId === "string" && prev.id === e.parentId;
    if (chained) {
      const prevContent = Array.isArray(prev.message.content) ? prev.message.content : [];
      const curContent = Array.isArray(e.message.content) ? e.message.content : [];
      prev.message.content = [...prevContent, ...curContent];
      // 时间戳保留较早的；其它字段不动。
      out[out.length - 1] = JSON.stringify(prev);
      mergedAway.add(e.id);
      merged += 1;
      continue;
    }
    out.push(lines[i]);
  }
  if (!merged) return { lines, merged: 0 };
  // 被合并掉的那条可能还被别人当 parent：接到合并后的那一条上。
  const rewired = [];
  for (const line of out) {
    let e;
    try { e = JSON.parse(line); } catch { rewired.push(line); continue; }
    if (typeof e?.parentId === "string" && mergedAway.has(e.parentId)) {
      // 一路往上找到没有被合并掉的祖先
      let cur = e.parentId;
      const guard = new Set();
      while (typeof cur === "string" && mergedAway.has(cur) && !guard.has(cur)) {
        guard.add(cur);
        const idx = byId.get(cur);
        cur = idx === undefined ? null : entries[idx]?.parentId;
      }
      e.parentId = typeof cur === "string" ? cur : null;
      rewired.push(JSON.stringify(e));
    } else rewired.push(line);
  }
  // 同 applyRemoval：指向被合并掉的条目的 context_edit 已成死引用，一并删。
  const cleaned = [];
  let cascadedEdits = 0;
  for (const line of rewired) {
    let e;
    try { e = JSON.parse(line); } catch { cleaned.push(line); continue; }
    if (e?.type === "context_edit" && typeof e.targetId === "string" && mergedAway.has(e.targetId)) { cascadedEdits += 1; continue; }
    cleaned.push(line);
  }
  return { lines: cleaned, merged, cascadedEdits };
}

export function pruneAll(lines, entries, opts = {}, maxRounds = 5) {
  let cur = lines;
  let curEntries = entries;
  let removed = 0;
  let rewired = 0;
  let stripped = 0;
  let usersMerged = 0;
  let cascaded = 0;
  let asstRemoved = 0;
  // 这两个数必须一起带出去：判据要用它们对账。
  // 漏传时「删对了」会被判成损坏（2026-11-26 实测：prune-session 在这个口径上永远 FAIL）。
  let editsRevoked = 0;
  let thinkRemoved = 0;
  let orphansDropped = 0;
  let mergedLastRound = false;
  let rounds = 0;
  const parse = (ls) => ls.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  for (; rounds < maxRounds; rounds += 1) {
    const anomalies = findAnomalies(curEntries, opts);
    const chosen = anomalies.filter((a) => REMOVABLE.includes(a.kind));
    // 摘块与删条目在同一轮里都要做：只做删条目会让「有正文 + 死调用」那种消息永远留在原地
    // （它不是 REMOVABLE，只有那个块该走）。顺序：先摘块（不动行数）再删条目（动行数）。
    const strippable = anomalies.filter((a) => a.block !== null && !REMOVABLE.includes(a.kind) && (a.kind === KIND.UNRESOLVED_TOOLCALL));
    // 合并不算「改动」时也要看上一轮有没有合并过：连续三条 user 要两轮才能并干净
    // （第一轮并 A+B，C 的 parentId 还指着 B；重连把它接到 A 之后，第二轮才认得出 A 与 C 相邻）。
    // 2026-11-25 实测：只看 chosen/strippable 就 break，留下 1 对相邻 user，API 会 400。
    if (!chosen.length && !strippable.length && !mergedLastRound) break;
    if (rounds > 0) cascaded += chosen.length + strippable.length;
    mergedLastRound = false;

    if (strippable.length) {
      const s = applyStripBlocks(cur, curEntries, strippable);
      cur = s.lines;
      stripped += s.stripped;
      asstRemoved += s.emptied;
      curEntries = parse(cur);
    }
    if (chosen.length) {
      const r = applyRemoval(cur, curEntries, chosen);
      cur = r.lines;
      removed += r.removed;
      rewired += r.rewired;
      asstRemoved += r.asstRemoved;
      editsRevoked += r.editsRevoked || 0;
      thinkRemoved += r.thinkRemoved || 0;
      orphansDropped += r.orphansDropped || 0;
      curEntries = parse(cur);
    }
    // 合并相邻 user **每轮都做**，不只在删过条目时：上一轮的合并可能让链上又出现新的相邻对
    // （合并把 A 接上 B 之后，B 与它新的 parent 也可能都是 user）。实测有文件需要第二轮才合并干净。
    {
      const m = mergeAdjacentUsers(cur, curEntries);
      if (m.merged) {
        cur = m.lines;
        usersMerged += m.merged;
        mergedLastRound = true;
        curEntries = parse(cur);
      }
    }
  }
  return { lines: cur, removed, rewired, stripped, usersMerged, asstRemoved, cascaded, rounds, editsRevoked, thinkRemoved, orphansDropped };
}

/**
 * 按**用户勾选**执行：只动 chosen 里点的那些，不自己找新异常。
 *
 * 与 pruneAll 的分工：pruneAll 是「全自动清一遍」（CLI 用），这个是「照勾选执行」（界面用）。
 * 界面里人勾了 3 条却删了 50 条，是不可接受的——所以这里绝不重新判断异常，
 * 唯一会连带发生的是两件**结构必需**的事：级联删死引用（在 applyRemoval 内）、
 * 合并相邻 user（API 要求交替）。两件都会如实报数。
 */
export function applyChosen(lines, entries, chosen, opts = {}) {
  const parse = (ls) => ls.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  let cur = lines;
  let ce = entries;
  let stripped = 0;
  let removed = 0;
  let rewired = 0;
  let cascadedEdits = 0;
  let editsRevoked = 0;
  let usersMerged = 0;
  let asstRemoved = 0;
  let thinkRemoved = 0;
  let orphansDropped = 0;

  const strippable = chosen.filter((a) => a.block !== null);
  if (strippable.length) {
    const s = applyStripBlocks(cur, ce, strippable);
    cur = s.lines;
    stripped += s.stripped;
    asstRemoved += s.emptied;
    ce = parse(cur);
  }
  const removable = chosen.filter((a) => a.block === null);
  if (removable.length) {
    const r = applyRemoval(cur, ce, removable);
    cur = r.lines;
    removed += r.removed;
    rewired += r.rewired;
    asstRemoved += r.asstRemoved;
    cascadedEdits += r.cascadedEdits;
    thinkRemoved += r.thinkRemoved || 0;
      orphansDropped += r.orphansDropped || 0;
    editsRevoked += r.editsRevoked || 0;
    ce = parse(cur);
  }
  // 合并要迭代：连续三条 user 需要两轮（第一轮并 A+B，C 的 parent 指向 B，重连后第二轮才认得出）。
  for (let round = 0; round < 5; round += 1) {
    const m = mergeAdjacentUsers(cur, ce);
    if (!m.merged) break;
    cur = m.lines;
    usersMerged += m.merged;
    ce = parse(cur);
  }
  // editsRevoked 必须透传：/api/apply 要把它交给 verify，否则「有意撤销」被当成「损坏」，
  // 整批 context_edit 清理都会被拒（2026-11-26 e2e 实测：报「有意撤销 0 条」而实际撤了几千条）。
  return { lines: cur, stripped, removed, rewired, cascadedEdits, usersMerged, asstRemoved, editsRevoked, thinkRemoved, orphansDropped };
}

export function applyFold(lines, entries, chosen, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const byKey = new Map();
  for (const a of chosen) {
    if (a.block === null || !FOLDABLE.includes(a.kind)) continue;
    const k = a.entry + ":" + a.block;
    if (!byKey.has(k)) byKey.set(k, a);
  }
  if (!byKey.size) return { lines, folded: 0, bytes: 0 };
  const out = [];
  let folded = 0;
  let bytes = 0;
  const foldStr = (s, head, tail, label) => {
    if (typeof s !== "string" || s.length <= head + tail) return null;
    const next = s.slice(0, head) + "…［已折叠" + label + " " + (s.length - head - tail) + " 字，原 " + s.length + " 字］…" + s.slice(-tail);
    bytes += bytesOf(s) - bytesOf(next);
    return next;
  };
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const content = e?.message?.content;
    if (!e || !Array.isArray(content)) { out.push(lines[i]); continue; }
    let changed = false;
    for (let k = 0; k < content.length; k += 1) {
      const a = byKey.get(i + ":" + k);
      if (!a) continue;
      const b = content[k];
      // 超上限的图片与重复图走同一条路：把 data 换成 1x1 占位并记 foldedFrom。
      // 块类型仍是 image，所以结构不变；模型下一轮看到的是「一张极小图」，不再是几百 KB。
      if (a.kind === KIND.DUP_IMAGE || a.kind === KIND.IMAGE_OVERFLOW) {
        bytes += bytesOf(b.data);
        content[k] = { ...b, data: DOT_PNG, mimeType: "image/png", foldedFrom: b.data.length };
        changed = true; folded += 1; continue;
      }
      if (a.kind === KIND.BIG_TEXT) {
        const next = foldStr(b.text, o.head, o.tail, "正文");
        if (next) { content[k] = { ...b, text: next }; changed = true; folded += 1; }
        continue;
      }
      if (a.kind === KIND.BIG_THINKING) {
        const next = foldStr(b.thinking, o.headThink, o.tailThink, "思考");
        if (next) { content[k] = { ...b, thinking: next }; changed = true; folded += 1; }
        continue;
      }
      if (a.kind === KIND.BIG_TOOLCALL) {
        const args = {};
        let touched = false;
        for (const [key, value] of Object.entries(b.arguments)) {
          if (typeof value === "string" && bytesOf(value) > o.minBytes) {
            const next = foldStr(value, 800, 200, "参数");
            if (next) { args[key] = next; touched = true; } else args[key] = value;
          } else args[key] = value;
        }
        if (touched) { content[k] = { ...b, arguments: args }; changed = true; folded += 1; }
      }
    }
    out.push(changed ? JSON.stringify(e) : lines[i]);
  }
  return { lines: out, folded, bytes };
}

/** 备份保留策略（2026-11-26 补：此前只写不删）。
 *
 * 实测：111 份 / 6.1 GB，其中 109 份是 24 小时内产生的 —— 一天跑 109 次，每次留一份整份副本。
 * 原因不是「留多了」，是**根本没有删除**：writeWithBackup 只写不删。
 *
 * 只清本工具写的那种目录（名字以时间戳开头）。chainfix-*、*.old 一概不碰：
 * 那些不是本工具写的，删别人的东西比留着自己的垃圾更糟。
 *
 * 份数是**硬上限**；天数只是保底（默认 1 天：今天产生的退路今天不删）。
 * 为什么天数不能写大（初版写 7 天）：上面那 109 份全在 7 天内，天数闸一个都拦不住。
 *
 * 删不动就跳过：备份清理失败不该让一次写盘失败。
 */
export function pruneBackups(root, opts = {}) {
  const keepRecent = Number.isFinite(opts.keepRecent) ? opts.keepRecent : 10;
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : 1;
  const STAMP = /^\d{4}-\d{2}-\d{2}T/;
  let names;
  try { names = readdirSync(root, { withFileTypes: true }); } catch { return { kept: 0, removed: [], bytes: 0 }; }
  // 也要管「平铺的备份文件」：早期版本直接把 <时间戳>_<uuid>.jsonl 写在备份根下，
  // 实测还有 17 个 / 0.25 GB。同一工具的产物用同一策略，否则清完目录还剩一堆文件。
  const BACKUP_FILE = /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/;
  const all = names.filter((d) => (d.isDirectory() && STAMP.test(d.name)) || (!d.isDirectory() && BACKUP_FILE.test(d.name))).map((d) => d.name).sort().reverse();
  const dirs = all;
  const cutoff = Date.now() - keepDays * 86400000;
  const removed = [];
  let bytes = 0;
  for (let i = 0; i < dirs.length; i += 1) {
    if (i < Math.max(1, keepRecent)) continue;
    const full = join(root, dirs[i]);
    let mtime = 0;
    // 时间取**名字里的**，不取 mtime：touching 一下就让旧备份变“新”，沙箱里实测过
    // （2026-01 的 15 份因为刚创建，mtime 是现在，一份都不删）。名字里的时间戳才是这条数据的真值。
    // 名字形如 2026-11-26T10-39-52-863Z：日期里的 - 保留，时间里的 - 换成 : 和 .
    const nm = dirs[i].match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
    mtime = nm ? Date.parse(nm[1] + "-" + nm[2] + "-" + nm[3] + "T" + nm[4] + ":" + nm[5] + ":" + nm[6] + "." + nm[7] + "Z") : 0;
    if (!Number.isFinite(mtime)) mtime = 0;
    if (!mtime) { try { mtime = statSync(full).mtimeMs; } catch { continue; } }
    if (mtime > cutoff) continue;
    let size = 0;
    try { size = statSync(full).isDirectory() ? dirSize(full) : statSync(full).size; } catch { /* 量不到也照样删 */ }
    try { rmSync(full, { recursive: true, force: true }); removed.push(dirs[i]); bytes += size; } catch { /* 占用：下次再来 */ }
  }
  return { kept: Math.min(Math.max(1, keepRecent), dirs.length), removed, bytes };
}

const dirSize = (dir) => {
  let n = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    try { n += d.isDirectory() ? dirSize(p) : statSync(p).size; } catch { /* 读不到的跳过 */ }
  }
  return n;
};
/** 写盘：先复制原件到备份目录（逐字节），再覆盖。返回备份路径。 */
export function writeWithBackup(file, lines, backupDir) {
  const bytes = lines.join("\n") + "\n";
  const dst = mkdirSync(backupDir, { recursive: true }) ?? backupDir;
  const bk = join(backupDir, basename(file));
  copyFileSync(file, bk);
  if (statSync(bk).size !== statSync(file).size) throw new Error("备份大小与原件不符：" + bk);
  writeFileSync(file, bytes);
  return { backup: bk, dir: dirname(file) };
}
