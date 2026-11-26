/**
 * 前端状态机 + 订阅。界面只读这里的状态，只通过 action 改状态。
 *
 * 为什么要有它（用户原话：「我要知道他到底在没在运行，要有状态机」）：
 * 之前把 phase 存在一个 let 里、各处自己改按钮文案，结果出现「转圈转着但按钮能点」
 * 「报错了转圈还在转」——因为没有一个地方负责把四个指示器一起复位。
 * 现在 **setState 是唯一的写入口**，视图是 state 的纯函数。
 *
 *   idle ──scan→ scanning ──ok→ idle
 *                     └─err→ error ──retry→ scanning
 *   idle ──apply→ applying ──ok→ scanning（改完自动重扫）
 *                     └─err→ error
 */

import { actionOf, metaOf } from "./kinds.js";

export const PHASE = {
	IDLE: "idle",
	SCAN: "scanning",
	APPLY: "applying",
	ERROR: "error",
};

/** 「全部会话」伪文件的索引。真实文件从 0 开始，-1 不会撞。 */
export const ALL = -1;

const listeners = new Set();

let state = {
	phase: PHASE.IDLE,
	files: [],
	/** 当前选中：ALL 或文件下标 */
	cur: ALL,
	/** 已勾选：Set<"<fileIdx>|<entry>:<block|e>"> */
	picks: new Set(),
	/** 最近一次成功扫描的时刻与耗时 */
	stamp: "",
	durationMs: 0,
	/** 出错时的可读原因 */
	error: "",
	/** 部分成功的可读原因（例如「3 个文件被拒绝写盘」）。与 error 分开：
	 *  error 是「这次没连上/没跑成」，warn 是「跑完了但有几份没写」。两者混用会让界面把
	 *  「服务正常、只是有拒绝」显示成「连不上本地服务」（2026-11-25 用户截图指出）。 */
	warn: "",
	/** 执行进度（applying 时用）：{ done, total, note } */
	progress: null,
};

export function getState() {
	return state;
}

export function subscribe(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function setState(patch) {
	state = { ...state, ...patch };
	for (const fn of listeners) fn(state);
}

/** 勾选键：必须含文件下标。全局视图里同一个 entry 号在不同文件里是不同东西。 */
export function pickKey(fileIdx, a) {
	return fileIdx + "|" + a.entry + ":" + (a.block === null || a.block === undefined ? "e" : a.block);
}

/** 当前视图要显示的异常（每条带 fileIdx / fileName）。 */
export function visibleAnomalies(s = state) {
	if (s.cur === ALL) {
		const out = [];
		s.files.forEach((f, fi) => {
			for (const a of f.anomalies) out.push({ ...a, fileIdx: fi, fileName: f.name });
		});
		// 聚合行（一行代表成百上千条）排最前：虚拟化只渲视口内的十几行，
		// 排在十万条明细后面就等于看不见。2026-11-26 实测：新加的「思考签名」一类
		// 把「改写账本」聚合行挤出视口，人以为那类问题不存在。
		out.sort((x, y) => (y.aggregate ? 1 : 0) - (x.aggregate ? 1 : 0));
		return out;
	}
	const f = s.files[s.cur];
	if (!f) return [];
	return f.anomalies.map((a) => ({ ...a, fileIdx: s.cur, fileName: f.name }));
}

/**
 * 单个文件的统计。**唯一算法**——顶栏、汇总卡、每张文件卡片都从这里取。
 * 2026-11-25 截图实测：卡片自己又写了一遍 remove/fold 过滤（还绕过了 metaOf），
 * 于是同一个文件在卡片上写「可折 2」、在清单里有 3 条 —— 两处各算一遍必然分叉。
 */
export function fileTotals(f) {
	let anomalies = 0, removable = 0, foldable = 0, relink = 0, clean = 0, bytes = 0;
	for (const a of f.anomalies || []) {
		anomalies += 1;
		bytes += a.bytes || 0;
		const act = actionOf(a.kind);
		if (act === "remove") removable += 1;
		else if (act === "fold" || act === "strip") foldable += 1;
		else if (act === "relink") relink += 1;
		else if (act === "clean") clean += 1;
	}
	return { anomalies, removable, foldable, relink, clean, bytes };
}

/** 统计：顶栏与汇总卡共用同一份算法。 */
export function totals(s = state) {
	let anomalies = 0, removable = 0, foldable = 0, relink = 0, clean = 0, bytes = 0;
	for (const f of s.files) {
		const t = fileTotals(f);
		anomalies += t.anomalies; removable += t.removable; foldable += t.foldable; bytes += t.bytes; relink += t.relink; clean += t.clean;
	}
	return { files: s.files.length, anomalies, removable, foldable, relink, clean, bytes };
}

/** 已勾选条目的统计。 */
export function picked(s = state) {
	let n = 0, bytes = 0;
	s.files.forEach((f, fi) => {
		for (const a of f.anomalies) {
			if (!s.picks.has(pickKey(fi, a))) continue;
			n += 1;
			bytes += a.bytes || 0;
		}
	});
	return { n, bytes };
}

/** 勾选/取消一条。 */
export function togglePick(fileIdx, anomaly, on) {
	const next = new Set(state.picks);
	const k = pickKey(fileIdx, anomaly);
	if (on) next.add(k); else next.delete(k);
	setState({ picks: next });
}

/**
 * 按类别批量勾选（replace 语义：先清空）。
 *
 * 作用域 = **当前视图**。「勾选全部可删」在单文件视图里若把别的文件也勾上，
 * 人看到自己只盯着 A，点一下执行却改了 B —— 屏幕上没有任何东西指出这一点。
 * 2026-11-25 修：单文件视图只勾那一个文件；「全部会话」视图才遍及所有文件。
 */
export function pickKinds(actions) {
	const next = new Set();
	const scope = state.cur === ALL
		? state.files.map((f, fi) => [f, fi])
		: (state.files[state.cur] ? [[state.files[state.cur], state.cur]] : []);
	for (const [f, fi] of scope) {
		for (const a of f.anomalies) if (actions.includes(actionOf(a.kind))) next.add(pickKey(fi, a));
	}
	setState({ picks: next });
}

/** 当前视图里的异常按 kind 分组：给「每类一个复选框」用。
 *  count 用真实条数（聚合项算 count 条），picked 同理 —— 否则复选框写「1」实际 12 万条。
 *  full = 这一类在当前视图里全被勾上（复选框只在三态都一致时才叫「全选」）。
 */
export function kindGroups(s = state) {
	const scope = s.cur === ALL
		? s.files.map((f, fi) => [f, fi])
		: (s.files[s.cur] ? [[s.files[s.cur], s.cur]] : []);
	const map = new Map();
	for (const [f, fi] of scope) {
		for (const a of f.anomalies || []) {
			const n = a.aggregate ? a.count : 1;
			let g = map.get(a.kind);
			if (!g) { g = { kind: a.kind, count: 0, picked: 0 }; map.set(a.kind, g); }
			g.count += n;
			if (s.picks.has(pickKey(fi, a))) g.picked += n;
		}
	}
	const out = [];
	for (const g of map.values()) {
		if (!g.count) continue;
		out.push({ ...g, ...metaOf(g.kind), full: g.picked >= g.count });
	}
	out.sort((a, b) => b.count - a.count);
	return out;
}

/** 勾选/取消某一类（当前视图作用域）。已经是全选就整类取消，否则整类勾上。 */
export function toggleKind(kind) {
	const scope = state.cur === ALL
		? state.files.map((f, fi) => [f, fi])
		: (state.files[state.cur] ? [[state.files[state.cur], state.cur]] : []);
	const hit = [];
	for (const [f, fi] of scope) for (const a of f.anomalies || []) if (a.kind === kind) hit.push([fi, a]);
	if (!hit.length) return;
	const all = hit.every(([fi, a]) => state.picks.has(pickKey(fi, a)));
	const next = new Set(state.picks);
	for (const [fi, a] of hit) {
		const k = pickKey(fi, a);
		if (all) next.delete(k); else next.add(k);
	}
	setState({ picks: next });
}

/** 把勾选整理成「按文件分组」的请求体。没勾的文件不出现。 */
export function groupPicks(s = state) {
	const byFile = new Map();
	s.files.forEach((f, fi) => {
		const hit = f.anomalies.filter((a) => s.picks.has(pickKey(fi, a)));
		if (!hit.length) return;
		byFile.set(fi, {
			index: fi,
			path: f.path,
			name: f.name,
			sizeMB: f.sizeMB,
			// 聚合项（aggregate: entry=-1）走 all:true：服务端自己重新判定该类全部。
			// 界面**不传**上万条下标 —— 那既超请求体上限，又把判定复制到界面上（判定只能一处）。
			entries: hit.map((a) => (a.aggregate
				? { entry: -1, block: null, kind: a.kind, aggregate: true }
				: { entry: a.entry, block: a.block, kind: a.kind })),
			// 计数：聚合项算它代表的**真实条数**，不是 1。
			// 否则确认框写「将删 1 条」而实际删 12 万条 —— 那是假话，而且是关于不可逆动作的假话。
			rem: hit.filter((a) => actionOf(a.kind) === "remove").reduce((n, a) => n + (a.aggregate ? a.count : 1), 0),
			relink: hit.filter((a) => actionOf(a.kind) === "relink").reduce((n, a) => n + (a.aggregate ? a.count : 1), 0),
			clean: hit.filter((a) => actionOf(a.kind) === "clean").reduce((n, a) => n + (a.aggregate ? a.count : 1), 0),
			fold: hit.filter((a) => actionOf(a.kind) !== "remove").reduce((n, a) => n + (a.aggregate ? a.count : 1), 0),
			bytes: hit.reduce((n, a) => n + (a.bytes || 0), 0),
		});
	});
	return [...byFile.values()];
}
