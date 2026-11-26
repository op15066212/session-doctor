/**
 * 接线层：api（请求）· store（状态）· components（视图）三者在这里汇合。
 *
 * 一个动作 = 改一次 state，视图由 subscribe → render 自动重画。
 * 动作里**绝不直接碰 DOM** —— 那是「点了状态变了但没重画」的来源。
 */
import { h, render } from "./vendor/preact.mjs";
import htm from "./vendor/htm.mjs";
import { api } from "./api.js";
import { PHASE, ALL, getState, setState, subscribe, togglePick, toggleAll, toggleActions, toggleKind, groupPicks } from "./store.js";
import { fmtMB, fmtClock } from "./format.js";
import { TopBar, ErrorBar, WarnBar, StatusBar, Sidebar, Toolbar, RowList, LogPanel, ConfirmDialog } from "./components.js";

const html = htm.bind(h);

/** 只为确认框与日志留的局部状态（不进 store：它们是瞬时 UI，不是数据）。 */
let ui = { asking: false, log: ["就绪。点右上角「重新扫描」开始。"] };
function setUi(patch) {
	ui = { ...ui, ...patch };
	repaint();
}

function repaint() {
	const state = getState();
	render(html`<${App} state=${state} ui=${ui} />`, document.getElementById("root"));
}

function App({ state, ui }) {
	return html`
		<${TopBar} state=${state} onScan=${scan} />
		<${ErrorBar} state=${state} onRetry=${scan} />
		<${WarnBar} state=${state} />
		<${StatusBar} state=${state} />
		<main class="body">
			<${Sidebar} state=${state} onSelect=${selectFile} />
			<section class="panel">
				<${Toolbar} state=${state} onToggleAll=${toggleAll} onToggleActions=${toggleActions}
				onToggleKind=${toggleKind} onApply=${askApply} />
				<${RowList} key=${"cur:" + state.cur} state=${state} onToggle=${(a, on) => togglePick(a.fileIdx, a, on)} />
			</section>
		</main>
		<${LogPanel} lines=${ui.log} />
		<${ConfirmDialog}
			open=${ui.asking}
			title="确认执行？"
			body=${ui.askBody || ""}
			onCancel=${() => setUi({ asking: false })}
			onConfirm=${doApply} />`;
}

/* ── 动作 ─────────────────────────────────────── */

function selectFile(i) {
	setState({ cur: i });
}

/**
 * 两个互斥标记：扫描与执行各自只有一个在飞。
 *
 * 为什么要它（2026-11-25 实测）：点「重新扫描」时人会连点两下（第一次没有立刻反应），
 * 两个请求并发飞回来，后到的覆盖先到的 —— phase、stamp、files 各来自不同的一次扫描，
 * 界面上就是「转圈停了但时间戳是新的」「文件数变了异常数没变」这类对不上的症状。
 * 按钮 disabled 只挡住鼠标，挡不住键盘回车与两次点击之间那一帧；这里是第二道防线。
 */
let scanning = false;
let applying = false;
/** 扫描序号：每次扫描 +1。老响应回来时序号已过期就丢弃，不回写界面。 */
let scanSeq = 0;

/**
 * 用户点的「重新扫描」。
 * 执行中、扫描中点击一律丢弃：并发两个扫描时后到的响应覆盖先到的，
 * 界面就出现「转圈停了但时间戳是新的」「文件数变了异常数没变」（2026-11-25 实测）。
 * 按钮 disabled 只挡住鼠标，挡不住回车键与两次点击之间那一帧；这里是第二道。
 */
async function scan(opts = {}) {	if (scanning || applying) return;
	await runScan(opts);
}

/**
 * 真扫一次。不查互斥 —— 执行完的重扫要走这里（那时 scanning/applying 由调用方持有）。
 *
 * opts.append: 把「扫描完成」这一行**接在**现有日志后面，不覆盖。
 * 执行完必须用它：否则执行结果（哪几份写了、哪几份被拒）会被扫描那一行直接盖掉，
 * 人看到的是「扫描完成」，而真正想问的是「我刚才那一下到底成没成」。
 */
async function runScan(opts = {}) {	scanning = true;
	const my = ++scanSeq;
	const t0 = performance.now();
	setState({ phase: PHASE.SCAN, error: "", progress: { done: 0, total: 0, note: "正在读会话文件…" } });
	if (!opts.append) setUi({ log: ["正在扫描…（大文件要几秒）"] });

	try {
		const res = await api.scan();
		// 序号变了 = 已经有更新的一次扫描在跑，这份结果作废。
		// 不回写是唯一能让「谁的结果算数」有答案的办法：按到达顺序写，就是让慢的那次赢。
		if (my !== scanSeq) return;

		if (!res.ok) {
			setState({ phase: PHASE.ERROR, error: res.error, warn: "", progress: null });
			setUi({ log: ['<span class="no">扫描失败</span>  ' + res.error] });
			return;
		}
		const ms = Math.round(performance.now() - t0);
		const n = res.data.reduce((k, f) => k + f.anomalies.length, 0);
		// 保留当前视图：执行完的重扫若跳回「全部会话」，人刚盯着的那个文件就丢了，
		// 而他要看的恰恰是那个文件有没有被改坏。下标越界才回 ALL。
		const keep = getState().cur;
		const cur = keep !== ALL && res.data[keep] ? keep : ALL;
		setState({
			phase: PHASE.IDLE, files: res.data, cur, picks: new Set(),
			stamp: fmtClock(), durationMs: ms, progress: null, error: "", warn: "",
		});
		const line = "扫描完成：" + res.data.length + " 个文件，" + n + " 条异常（用时 " + ms + " ms）。";
		setUi({ log: opts.append ? [...ui.log, line] : [line] });
	} finally {
		// 只有最新那一次扫描才有权把锁放掉：老的那次放锁，会让第二次扫描的标志被清掉。
		if (my === scanSeq) scanning = false;
	}
}

function askApply() {
	const groups = groupPicks();
	if (!groups.length) return;
	const rem = groups.reduce((n, g) => n + g.rem, 0);
	const fold = groups.reduce((n, g) => n + g.fold, 0);
	const bytes = groups.reduce((n, g) => n + g.bytes, 0);
	setUi({
		asking: true,
		askBody: "将改动 " + groups.length + " 个文件：删 " + rem + " 条、折 " + fold + " 块，约省 " + fmtMB(bytes)
			+ "。\n\n执行前每个文件整份备份到 .session-backups/<时间戳>/；结构判据不通过就拒绝写盘。",
	});
}

async function doApply() {	if (applying) return;
	const groups = groupPicks();
	setUi({ asking: false });
	if (!groups.length) return;

	applying = true;
	try {
		setState({ phase: PHASE.APPLY, error: "", progress: { done: 0, total: groups.length, note: "准备执行…" } });
		const lines = [];
		let failed = 0;
		for (const [i, g] of groups.entries()) {
			setState({
				phase: PHASE.APPLY,
				progress: { done: i, total: groups.length, note: "执行中 " + (i + 1) + "/" + groups.length + "：" + g.name.slice(0, 18) + "…" },
			});			const res = await api.apply(g.path, g.entries);			if (!res.ok) {
				failed += 1;
			const why = res.error || "服务没给原因（这条本身是缺陷：失败必须说出为什么）";
			lines.push('<span class="no">✕ 失败</span>  ' + g.name.slice(0, 30) + "  " + why);
				continue;
			}
			const r = res.data;
			if (r.ok) {
				const bits = [];
				if (r.removed) bits.push("删 " + r.removed);
				if (r.stripped) bits.push("摘块 " + r.stripped);
				if (r.usersMerged) bits.push("并 user " + r.usersMerged);
				if (r.folded) bits.push("折 " + r.folded);
				if (r.cascadedEdits) bits.push("级联 " + r.cascadedEdits);
				lines.push('<span class="ok">✓ 完成</span>  ' + g.name.slice(0, 30) +
					"  " + g.sizeMB + " → " + r.sizeMB + " MB   " + (bits.join(" · ") || "无变化") + "   备份 " + r.backup);
			} else {
				failed += 1;
			const red = (r.checks || []).filter((c) => !c[1]).map((c) => c[0] + ":" + c[2]).join("   ");
			const why = (r.reason || "") + (red ? "\n      " + red : "");
			lines.push('<span class="no">✕ 拒绝</span>  ' + g.name.slice(0, 30) + "  " +
				(why.trim() || "未给出原因（这条本身是缺陷：拒绝必须说出哪条判据红了）"));
			}
		}
		setState({ picks: new Set() });

		// 先落日志，再重扫（append）：顺序颠倒的话「扫描完成」会盖掉执行结果。
		// 扫描/执行之后**必须重扫**：列表还停在执行前，磁盘已经不是那样了 ——
		// 之前只在全成功时重扫，于是「有拒绝」的那一次列表永远比磁盘多几条，
		// 人再点一次执行，就是在对已经不存在的条目动手。
		setUi({ log: lines });
		await runScan({ append: true });

		if (failed) {
			// 部分文件被结构判据挡住 ≠ 连不上服务。停在 idle + warn：连接是好的，只是有几份没写。
			setState({ phase: PHASE.IDLE, warn: failed + " 个文件被拒绝写盘，其余已完成。原因见下方日志。", progress: null });
		}
	} finally {
		applying = false;
	}
}

/* ── 启动 ─────────────────────────────────────── */
subscribe(repaint);
repaint();
scan();
