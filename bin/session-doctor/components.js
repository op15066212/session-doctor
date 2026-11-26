/**
 * 组件层。每个组件只做一件事，全部是纯函数：输入 props，输出视图。
 * 状态在 store.js，请求在 api.js，视图在这里，接线在 app.js —— 四层各管一件事。
 *
 * 模板用 htm 而不是 JSX：JSX 要 Babel 或 bundler，而这个工具的价值之一是
 * 「双击就跑、换台机器不用装东西」。htm 用模板字符串达到同样写法，零构建。
 */
import { h } from "./vendor/preact.mjs";
import { useRef, useMemo, useLayoutEffect, useEffect, useState } from "./vendor/preact-hooks.mjs";
import htm from "./vendor/htm.mjs";
import { Virtualizer, elementScroll, observeElementRect, observeElementOffset } from "./vendor/virtual-core/index.js";
import { ALL, PHASE, totals, fileTotals, picked, visibleAnomalies, pickKey, kindGroups, actionGroups } from "./store.js";
import { metaOf } from "./kinds.js";
import { fmtMB, fmtBytes, shortName, shortProject } from "./format.js";

const html = htm.bind(h);

/** 行高。虚拟化与 CSS 都读这一个值，两边不会对不上。 */
const ROW = 34;

/* ── 顶栏 ────────────────────────────────────────── */
export function TopBar({ state, onScan }) {
	const busy = state.phase === PHASE.SCAN || state.phase === PHASE.APPLY;
	const label = state.phase === PHASE.SCAN ? "扫描中"
		: state.phase === PHASE.APPLY ? "执行中"
		: state.phase === PHASE.ERROR ? "重试"
		: "重新扫描";
	return html`
		<header class="top">
			<span class="mark" aria-hidden="true">D</span>
			<div class="titles">
				<h1>会话医生</h1>
				<p class="sub">扫描全部会话 · 出示异常 · 勾选执行 · 每次执行前整份备份</p>
			</div>
			<div class="spacer"></div>
			<button id="btnScan" class="btn primary" disabled=${busy} onClick=${onScan}>
				<span class="spin ${busy ? "on" : ""}" aria-hidden="true"></span>
				<span id="btnScanLabel">${label}</span>
			</button>
		</header>`;
}

/* ── 错误条：连接失败时出现 ─────────────────────── */
export function ErrorBar({ state, onRetry }) {
	const on = state.phase === PHASE.ERROR;
	return html`
		<div class="errbar ${on ? "on" : ""}" role="alert">
			<span class="errbar-dot" aria-hidden="true"></span>
			<b>连不上本地服务</b>
			<code id="errMsg">${on ? state.error : ""}</code>
			<span class="spacer"></span>
			<button class="btn small" onClick=${onRetry}>重试连接</button>
		</div>`;
}

/**
 * 警告条：跑完了，但有几份没写。
 *
 * 为什么不复用错误条（2026-11-25 用户截图实测）：那条的标题写死「连不上本地服务」、
 * 按钮是「重试连接」、状态点变红。而实际情况是服务好好的、扫描正常、其余文件都写成功了，
 * 只是某几份没过结构判据。把它们塞进同一个条里，人看到的就是一句假话。
 */
export function WarnBar({ state }) {
	const on = Boolean(state.warn) && state.phase !== PHASE.ERROR;
	return html`
		<div class="warnbar ${on ? "on" : ""}" role="status">
			<span class="warnbar-dot" aria-hidden="true"></span>
			<b>部分文件未写盘</b>
			<code id="warnMsg">${on ? state.warn : ""}</code>
		</div>`;
}

/* ── 统计条 + 状态点 ───────────────────────────── */
export function StatusBar({ state }) {
	const t = totals(state);
	const p = picked(state);
	const scanned = state.files.length > 0;
	const busy = state.phase === PHASE.SCAN || state.phase === PHASE.APPLY;
	const dotClass = "dot" + (busy ? " busy" : state.phase === PHASE.ERROR ? " err" : state.phase === PHASE.IDLE && state.stamp ? " ok" : "");
	const stamp = state.stamp ? state.stamp + (state.durationMs ? " · " + (state.durationMs / 1000).toFixed(1) + "s" : "") : "";
	// 这些 id 不只是给判据用的：调试与端到端测试都靠它定位。
	// 只写 class 会让「取不到元素」和「元素没渲染」看起来一样。
	// 注意：注释必须写在 html 模板之外 —— 模板里的双斜杠会当文本渲染出来（真发生过）。
	return html`
		<div class="bar">
			<span class="stat"><i>文件</i><b id="nFiles">${scanned ? t.files : "—"}</b></span>
			<span class="stat"><i>异常</i><b id="nAnom">${scanned ? t.anomalies : "—"}</b></span>
			<span class="stat"><i>可省</i><b id="nSave">${scanned ? fmtMB(t.bytes) : "—"}</b></span>
			<span class="stat accent"><i>已勾选</i><b id="nPick">${p.n}</b></span>
			<span class="spacer"></span>
			<span class="phase">
				<span id="scanDot" class=${dotClass}></span>
				<span id="scanStamp">${stamp}</span>
				<span id="scanState">${state.progress?.note ?? ""}</span>
			</span>
		</div>`
}

/* ── 左侧卡片 ──────────────────────────────────── */
function Card({ cls, name, title, size, proj, projTitle, meta, onClick }) {
	return html`
		<div class=${cls} onClick=${onClick}>
			<div class="name" title=${title || name}>${name}</div>
			<div class="size">${size}</div>
			${proj ? html`<div class="proj" title=${projTitle || proj}>${proj}</div>` : null}
			<div class="meta">
				${meta.filter(Boolean).map(([text, tone]) => html`<span class=${tone ? "chip " + tone : ""}>${text}</span>`)}
			</div>
		</div>`;
}

export function Sidebar({ state, onSelect }) {
	if (!state.files.length) {
		return html`<aside class="sidebar">
			<div class="empty"><div class="ico">◍</div><div>没有找到会话文件</div>
			<div class="hint">检查 --dir 指的目录是否存在</div></div>
		</aside>`;
	}
	const t = totals(state);
	return html`
		<aside class="sidebar">
			<div class="files">
				<${Card}
					cls=${"card summary" + (state.cur === ALL ? " sel" : "")}
					name="全部会话" size=${t.files + " 个"}
					meta=${[
						[t.anomalies + " 条异常", ""],
						t.removable ? ["可删 " + t.removable, "warn"] : null,
						t.foldable ? ["可折 " + t.foldable, "warn"] : null,
						t.relink ? ["可接 " + t.relink, "info"] : null,
						t.clean ? ["可清 " + t.clean, "info"] : null,
						t.anomalies === 0 ? ["全部干净", "good"] : null,
						["省 " + fmtMB(t.bytes), ""],
					]}
					onClick=${() => onSelect(ALL)} />
				${state.files.map((f, i) => {
					// 统计只有一个算法（fileTotals）。之前这里自己又过滤了一遍，卡片就与清单对不上。
					const ft = fileTotals(f);
					return html`<${Card}
						cls=${"card" + (state.cur === i ? " sel" : "")}
						name=${shortName(f.name)} title=${f.name}
						size=${f.sizeMB + " MB"}
						proj=${shortProject(f.project)} projTitle=${f.project}
						meta=${[
							[f.entries + " 条", ""],
							ft.removable ? ["可删 " + ft.removable, "warn"] : null,
							ft.foldable ? ["可折 " + ft.foldable, "warn"] : null,
							ft.relink ? ["可接 " + ft.relink, "info"] : null,
							ft.clean ? ["可清 " + ft.clean, "info"] : null,
							ft.anomalies === 0 ? ["干净", "good"] : null,
							["省 " + fmtMB(ft.bytes), ""],
						]}
						onClick=${() => onSelect(i)} />`
				})}
			</div>
		</aside>`;
}

/* ── 工具栏 ────────────────────────────────────── */
export function Toolbar({ state, onToggleAll, onToggleActions, onToggleKind, onApply }) {
	const busy = state.phase === PHASE.SCAN || state.phase === PHASE.APPLY;
	const p = picked(state);
	// 作用域写进 title，不只在代码里：单文件视图下「全部可删」指的是这一份，
	// 文案若仍暗示全库，人以为改了所有会话（2026-11-25 修）。
	const one = state.cur !== ALL;
	const f = one ? state.files[state.cur] : null;
	const scope = one && f ? "此文件" : "全部";
	const scopeTitle = one && f ? "只勾选这个文件（" + shortName(f.name, 22) + "）" : "勾选所有文件";
	const groups = kindGroups(state);
	const acts = actionGroups(state);
	// 全选的三态：全部勾上才算「已全选」。数字用明细条数（聚合项算它代表的条数），
	// 否则屏幕上写「全选 645」而实际两万多条 —— 关于不可逆动作的数字必须是真数。
	const allCount = groups.reduce((n, g) => n + g.count, 0);
	const allPicked = groups.reduce((n, g) => n + g.picked, 0);
	const allFull = allCount > 0 && allPicked >= allCount;
	// 全部选择项都是复选框：全选 / 按动作 / 按类。执行仍是按钮（那是动作，不是选择）。
	// 面板是 grid-template-rows: auto 1fr，所以这两行必须包在同一个 .toolbars 里占一行。
	return html`
		<div class="toolbars">
			<div class="toolbar kinds">
				<label class="kindbox tone-all" title=${scopeTitle}>
					<input id="pickAll" type="checkbox" checked=${allFull} disabled=${busy || !allCount}
						ref=${(el) => { if (el) el.indeterminate = allPicked > 0 && !allFull; }}
						onChange=${() => onToggleAll()} />
						onChange=${() => onToggleAll()} />
					<span class="klabel">全选</span>
					<span class="kcnt">${allPicked ? allPicked + "/" : ""}${allCount}</span>
				</label>
				${acts.map((a) => html`<label class=${"kindbox tone-" + a.tone} title=${a.title + "（" + scope + "）"}>
					<input id=${"pickAct-" + a.act} type="checkbox" checked=${a.full} disabled=${busy || !a.count}
						ref=${(el) => { if (el) el.indeterminate = a.picked > 0 && !a.full; }}
						onChange=${() => onToggleActions(a.acts)} />
						onChange=${() => onToggleActions(a.acts)} />
					<span class="klabel">${a.label}</span>
					<span class="kcnt">${a.picked ? a.picked + "/" : ""}${a.count}</span>
				</label>`)}
			</div>
			<div class="toolbar kinds">
				${groups.map((g) => html`<label class=${"kindbox tone-" + (g.tone || "info")} title=${g.why}>
					<input id=${"pickKind-" + g.kind} type="checkbox" checked=${g.full} disabled=${busy}
						ref=${(el) => { if (el) el.indeterminate = g.picked > 0 && !g.full; }}
						onChange=${() => onToggleKind(g.kind)} />
						onChange=${() => onToggleKind(g.kind)} />
					<span class="klabel">${g.label}</span>
					<span class="kcnt">${g.picked ? g.picked + "/" : ""}${g.count}</span>
				</label>`)}
				<span class="spacer"></span>
				<span id="selInfo" class="selinfo">${p.n ? p.n + " 条 · 将省 " + fmtMB(p.bytes) : ""}</span>
				<button id="btnApply" class="btn danger small" disabled=${p.n === 0 || busy} onClick=${onApply}>执行</button>
			</div>
		</div>`;
}

/* ── 虚拟列表：TanStack virtual-core ───────────── */
export function RowList({ state, onToggle }) {
	const parentRef = useRef(null);
	const flat = visibleAnomalies(state);
	const wide = state.cur === ALL;

	// count 变时重建 options；getVirtualItems 每次渲染都读最新的滚动位置。
	// 三个函数是 TanStack 的**必需**选项（纯 core 不像 react adapter 那样给默认值）：
	//   scrollToFn        没有它 scrollToIndex 直接抛 "is not a function"（实测）
	//   observeElementRect / observeElementOffset  没有它们滚动事件没人接，列表永远不动
	// 都从库里取，不自己写：自己写就等于重新实现一遍测量与滚动锚定。
	const virtualizer = useMemo(() => new Virtualizer({
		count: 0,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW,
		overscan: 8,
		scrollToFn: elementScroll,
		observeElementRect,
		observeElementOffset,
	}), []);

	// 挂载后必须再渲染一次：首次渲染时 ref 还没绑定，getScrollElement() 返回 null，
	// virtualizer 算不出 items（列表会是空的）。TanStack 的 react adapter 也是这么做的。
	// 依赖写 [flat.length, state.cur]：切换文件或行数变了就重算并重画一次，不会自激。
	const [, setTick] = useState(0);
	useLayoutEffect(() => {
		virtualizer.setOptions({
			...virtualizer.options,
			count: flat.length,
			getScrollElement: () => parentRef.current,
			estimateSize: () => ROW,
			overscan: 8,
			scrollToFn: elementScroll,
			observeElementRect,
			observeElementOffset,
		});
		virtualizer._willUpdate();
		setTick((n) => n + 1);
	}, [flat.length, state.cur]);

	// 切换文件时回到顶部：留着上次的 scrollTop 会落在空区域。
	useEffect(() => { if (parentRef.current) parentRef.current.scrollTop = 0; }, [state.cur]);

	if (!flat.length) {
		return html`<div class="vwrap" ref=${parentRef}>
			<div class="empty">
				<div class="ico">✓</div>
				<div>${state.cur === ALL ? "全部会话干净，没有可处理的异常" : "这个文件没有异常"}</div>
			</div>
		</div>`;
	}

/**
 * 只取**这一帧真实存在**的行。
 *
 * 为什么必须过滤（2026-11-25 实测，用户说的「重复运行就出问题」的根因）：
 * virtualizer 的 count 由 useLayoutEffect 里的 setOptions 更新，而 layout effect 在
 * diff **之后**才跑 —— 所以某次渲染里它可能还拿着上一次的 count。
 * 执行完重扫使异常数从 3 降到 1 时，旧 count=3 → getVirtualItems() 返回 index 2 →
 * flat[2] 是 undefined → a.kind 抛 TypeError → **整个 render 抛异常，界面从此不再更新**。
 * 表现就是「点了没反应」「转圈不停」，而 console 里只有一条看不出位置的 TypeError。
 * 下游症状一堆，上游只有这一行。
 */
const items = virtualizer.getVirtualItems().filter((vi) => vi.index >= 0 && vi.index < flat.length);
	const total = virtualizer.getTotalSize();

	return html`
		<div class="vwrap" ref=${parentRef} data-row=${ROW} data-count=${flat.length}>
			<div style=${{ height: total + "px", position: "relative", width: "100%" }}>
				<div style=${{ position: "absolute", top: 0, left: 0, right: 0, transform: "translateY(" + (items[0]?.start ?? 0) + "px)" }}>
					${items.map((vi) => {
						const a = flat[vi.index];
						const meta = metaOf(a.kind);
						const checked = state.picks.has(pickKey(a.fileIdx, a));
						return html`
							<div class=${"row" + (wide ? " wide" : "")} key=${vi.key}>
								<input type="checkbox" checked=${checked} disabled=${meta.action === "info"}
									onChange=${(e) => onToggle(a, e.currentTarget.checked)} />
								<span class=${"tag " + meta.tone} title=${a.kind}>${meta.label}</span>
								<span class="bytes">${a.aggregate ? "×" + a.count : fmtBytes(a.bytes)}</span>
								${wide ? html`<span class="file" title=${a.fileName}>${shortName(a.fileName, 18)}</span>` : null}
								<span class="why" title=${a.why || meta.why}>
									${a.why || meta.why}
									${a.preview ? html` <small>${a.preview}</small>` : null}
								</span>
							</div>`;
					})}
				</div>
			</div>
		</div>`;
}

/* ── 日志 ──────────────────────────────────────── */
export function LogPanel({ lines }) {
	return html`<footer class="log" id="log">${lines.map((ln, i) => html`<div key=${i} dangerouslySetInnerHTML=${{ __html: ln }} />`)}</footer>`;
}

/* ── 确认框 ────────────────────────────────────── */
export function ConfirmDialog({ open, title, body, onCancel, onConfirm }) {
	if (!open) return null;
	return html`
		<div class="mask on">
			<div class="dlg" role="dialog" aria-modal="true">
				<h2>${title}</h2>
				<p>${body}</p>
				<div class="acts">
					<button class="btn" onClick=${onCancel}>取消</button>
					<button class="btn danger" onClick=${onConfirm}>确定执行</button>
				</div>
			</div>
		</div>`;
}
