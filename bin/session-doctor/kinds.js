/**
 * 异常类型表 —— 唯一源。store（统计与勾选）与 components（清单与卡片）都从这里取。
 *
 * 为什么必须抽出来（2026-11-25 端到端抓到的真 bug）：后端返回的 anomaly 只有 { kind, entry, block, bytes, why }，
 * **没有 action 字段**。而 store 里统计与「勾选全部可删」读的是 a.action ——
 * 于是可删数恒 0、按钮点了没反应。两处各自维护一份 kind→action 映射一定会这样分叉。
 *
 * action 语义：
 *   remove  整条删除
 *   strip   只摘掉命中的块（条目留下）
 *   fold    块内折叠
 *   relink  接回父指针（不删字节）
 *   clean   只删一个字段（块留下）
 *   info    只报告，不参与执行
 */
export const KINDS = {
	"zero-token":          { label: "空壳",     action: "remove", tone: "rem",  why: "空 content 且 0 token：失败的模型调用留下的空壳" },
	"dup-system":          { label: "重复快照", action: "remove", tone: "rem",  why: "与后面某条 system 快照内容完全相同（只保留最后一份）" },
	"dangling-edit":       { label: "悬空编辑", action: "remove", tone: "rem",  why: "targetId 已不存在，replacement 为 null" },
	"thinking-only":       { label: "孤立思考", action: "remove", tone: "rem",  why: "只有思考、无正文无工具调用，且没有可合并的兄弟" },
	"whitespace-only":     { label: "空白正文", action: "remove", tone: "rem",  why: "全部文本块都是空白" },
	"unresolved-toolcall": { label: "死调用",   action: "strip",  tone: "fold", why: "工具调用没有对应的结果（中断留下的死引用）" },
	"dup-image":           { label: "重复图",   action: "fold",   tone: "fold", why: "同一张图在这一会话里重复出现" },
	"big-text":            { label: "长正文",   action: "fold",   tone: "fold", why: "老轮次的长正文" },
	"big-thinking":        { label: "长思考",   action: "fold",   tone: "fold", why: "老轮次的长思考" },
	"big-toolcall":        { label: "长参数",   action: "fold",   tone: "fold", why: "老轮次的超长工具参数" },
	"unreachable":         { label: "脱链",     action: "info",   tone: "info", why: "从根沿 parentId 走不到（父指针还在，但链上有环或更早的断口）" },
	"broken-link":         { label: "断链",     action: "relink", tone: "rel",  why: "父指针指向的条目不在文件里：接回时间上紧邻的前一条，一个字节不删" },
	"thinking-signature":  { label: "思考签名", action: "clean",  tone: "clean", why: "思考块的 API 签名（openai-completions 忽略；anthropic 必需，别清错协议）" },
	"bad-line":            { label: "坏行",     action: "info",   tone: "info", why: "这一行不是合法 JSON" },
	// 上下文改写账本：某插件给每条 assistant 追加一条「同一消息的复制，只有 thinking 被截短」。
	// 单个文件实测 12.4 万条 / 305MB（占 87%）。删了对话一个字不丢 —— 它不含新内容，
	// 只是把模型上下文里那段 thinking 换成了短版。唯一影响：模型下一轮看到的是完整 thinking。
	"context-edit-dup":    { label: "改写账本", action: "remove", tone: "rem",  why: "目标消息的复制，只有 thinking 被截短（无新内容）" },
	// 同一目标的旧改写账本：pi 的 context_edit 是 append-only 覆盖，读时只取最后一条，
	// 前面的每条都被后来者顶掉、永远不进上下文。删掉不改变任何语义。
	// 实测某会话 478 个 target、平均每个被写 275 次 —— 这是无损清理里收益最大的一条。
	"context-edit-stale":  { label: "旧改写",   action: "remove", tone: "rem",  why: "同一目标的旧改写账本：只有最后一条生效，这条已被顶掉" },
};

/** 动作分组：给「全部可删 / 可折 / 可接 / 可清」四个复选框用。 */
/** 为什么动作分组也要在这张表里：界面与统计都从 metaOf 取，动作集合若另写一份，
 *  两处必然分叉 —— 2026-11-26 实测：fold 组的定义写成 ["fold"] 漏了 strip，
 *  于是「全部可折」点下去漏掉死调用那一类，而屏幕上没有任何东西指出这一点。 */
export const ACTIONS = {
	remove: { label: "全部可删", tone: "rem",   acts: ["remove"],            title: "删除类：整条 entry 去掉" },
	fold:   { label: "全部可折", tone: "fold",  acts: ["fold", "strip"],     title: "折叠与摘块：块内留头尾、或只摘掉死引用" },
	relink: { label: "全部可接", tone: "rel",   acts: ["relink"],            title: "接链：只改 parentId，不删字节" },
	clean:  { label: "全部可清", tone: "clean", acts: ["clean"],             title: "清字段：只删 thinkingSignature，思考正文不动" },
};

/** 未知 kind 一律当 info：宁可少删，也不要按猜测去动数据。 */
export function metaOf(kind) {
	return KINDS[kind] || { label: String(kind), action: "info", tone: "info", why: "" };
}

export const actionOf = (kind) => metaOf(kind).action;
