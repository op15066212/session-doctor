/**
 * 端到端探针（Electron 主进程）。由 check-ui-e2e.mjs 启动，不单独跑。
 *
 * 为什么单独成文件而不是嵌在字符串里：嵌字符串要转义模板反引号，第一次写就
 * 生成了一份语法坏的文件，Electron 直接 exit -1 且没有任何输出（2026-11-25 实测）。
 * 独立文件能被 node --check 直接验证。
 *
 * 结果写 out.json，不写 stdout：Windows 上 Electron 主进程的 stdout 走 pipe 时读不到。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// URL 走环境变量不走 argv：electron <app> <args...> 里带 URL 参数时
// 进程会以 rc=127 静默死掉、探针一行都不执行（2026-11-25 实测，参数加不加引号都一样）。
const URL_ = process.env.E2E_URL;
const OUT = path.join(__dirname, "out.json");
const HEADFUL = process.env.E2E_HEADFUL === "1";

const result = { res: {}, errors: [], console: [] };
const write = () => {
	try { fs.writeFileSync(OUT, JSON.stringify(result)); } catch { /* 写不出就算了 */ }
};

app.whenReady().then(async () => {
	// backgroundThrottling: false —— 关掉后台节流。
	// 为什么必须（2026-11-25 实测）：窗口 show:false 时 Chromium 把定时器与渲染帧压到极低频，
	// 于是 executeJavaScript 要等一帧才返回、读到的还是上一屏的 DOM：
	// 探针看到「执行中 1/1」持续 15 秒，而埋点日志显示 apply 早在 13 秒前就返回了。
	// 判据因此红在一片假象上（界面是对的，读数陈旧）。这不是界面 bug，是测具 bug。
	const win = new BrowserWindow({ show: HEADFUL, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
	win.webContents.setBackgroundThrottling(false);
	win.webContents.on("console-message", (...a) => {
		// 新签名是 (event)；旧签名是 (event, level, message)。
		const ev = a[0];
		const level = ev && typeof ev === "object" && "level" in ev ? ev.level : a[1];
		const msg = ev && typeof ev === "object" && "message" in ev ? ev.message : a[2];
		result.console.push(String(msg).slice(0, 120));
		if (Number(level) >= 2 && !String(msg).includes("Security Warning")) result.errors.push(String(msg));
	});

	// 页面里的异常必须看得见：判据只报「按钮没起来」时，无从知道是渲染崩了还是逻辑崩了。
	await win.loadURL(URL_);
	const js = (code) => win.webContents.executeJavaScript(code);
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));

	// 读数函数写成**真函数**，用 toString() 序列化后送进页面。
	// 反例（2026-11-25 连续撞了三次）：写成 "\"    key: ...,\"" 字符串数组时，每加一个字段就要
	// 手工数逗号，漏一个就整个探针语法错 —— 而语法错时 Electron 会弹原生框挂着等「确定」。
	// 真函数由 node --check 直接检查，逗号问题当场就炸在本地。
	function readInPage() {
		const q = (s) => document.querySelector(s);
		const rows = [...document.querySelectorAll('.row')];
		const cardMeta = [...document.querySelectorAll('.card')].map((c) => {
			const m = c.querySelector('.meta');
			return m ? m.textContent : '';
		});
		const spacer = q('.vwrap > div');
		const btns = document.querySelectorAll('.toolbar .btn');
		return {
			phase: q('#btnScanLabel') ? q('#btnScanLabel').textContent : null,
			btnDisabled: q('#btnScan') ? q('#btnScan').disabled : null,
			spin: q('.spin') ? q('.spin').className.includes('on') : null,
			dot: q('#scanDot') ? q('#scanDot').className : null,
			stamp: q('#scanStamp') ? q('#scanStamp').textContent : null,
			note: q('#scanState') ? q('#scanState').textContent : null,
			nFiles: q('#nFiles') ? q('#nFiles').textContent : null,
			nAnom: q('#nAnom') ? q('#nAnom').textContent : null,
			nPick: q('#nPick') ? q('#nPick').textContent : null,
			nSave: q('#nSave') ? q('#nSave').textContent : null,
			cards: document.querySelectorAll('.card').length,
			summarySel: q('.card.summary') ? q('.card.summary').className.includes('sel') : null,
			cardMeta,
			selCardMeta: q('.card.sel') ? q('.card.sel').textContent : '',
			rowCount: rows.length,
			firstFileCol: rows[0] && rows[0].querySelector('.file') ? rows[0].querySelector('.file').textContent : null,
			rowTags: rows.slice(0, 3).map((r) => (r.querySelector('.tag') || {}).textContent || null),
			rowKinds: rows.map((r) => (r.querySelector('.tag') || {}).textContent || ''),
			rowTagCount: rows.filter((r) => r.querySelector('.tag')).length,
			wideRows: document.querySelectorAll('.row.wide').length,
			fileCols: document.querySelectorAll('.row .file').length,
			applyDisabled: q('#btnApply') ? q('#btnApply').disabled : null,
			vsplits: document.querySelectorAll(".vsplit").length,
			hsplits: document.querySelectorAll(".hsplit").length,
			dlgOpen: Boolean(q('.mask.on')),
			errOn: Boolean(q('.errbar.on')),
			errBarOn: q('.errbar') ? q('.errbar').className.includes('on') : null,
			errMsg: q('#errMsg') ? q('#errMsg').textContent : null,
			warnOn: Boolean(q('.warnbar.on')),
			warnMsg: (q('#warnMsg') ? q('#warnMsg').textContent : '').slice(0, 60),
			dotCls: (q('#scanDot') ? q('#scanDot').className : ''),
			errs: (window.__errs || []).slice(0, 5),
			log: (q('#log') ? q('#log').textContent : '').slice(0, 800),
			logLines: document.querySelectorAll('#log > div').length,
			dlgText: q('.dlg') ? q('.dlg').textContent.slice(0, 120) : null,
			actIds: Array.from(document.querySelectorAll(".toolbar.kinds input")).map((i) => i.id).join(",").slice(0, 260),
			btnApplyId: Boolean(q("#btnApply")),
			pickRemoveText: q('#pickAct-remove') && q('#pickAct-remove').closest('label') ? q('#pickAct-remove').closest('label').getAttribute('title') : null,
			pickFoldText: q('#pickAct-fold') && q('#pickAct-fold').closest('label') ? q('#pickAct-fold').closest('label').getAttribute('title') : null,
			selInfo: q('#selInfo') ? q('#selInfo').textContent : null,
			spacerH: spacer ? spacer.style.height : null,
			// 总条数 = 占位高度 / 行高。行高不在这里写死：界面把它挂在 .vwrap[data-row] 上，
			// 改行高时探针自动跟着走（先前写死 /40，而真值 ROW=34，于是总条数永远少算。
			totalRows: (() => {
				const vw = q('.vwrap');
				const rowH = vw ? Number(vw.dataset.row || 0) : 0;
				const h = spacer ? parseFloat(spacer.style.height) : 0;
				return rowH > 0 && h > 0 ? Math.round(h / rowH) : null;
			})(),
			countAttr: (() => {
				const vw = q('.vwrap');
				return vw && vw.dataset.count ? Number(vw.dataset.count) : null;
			})(),
		};
	}
	const READ = "(" + readInPage.toString() + ")()";

	// 逐步执行，失败时记下是哪一段：一条 50 行的表达式报「Script failed to execute」
	// 等于没说，而这里最容易出事的是我自己写的转义正则。
	const stepErrors = [];
	const stepMs = {};
	const step = async (label, code) => {
		const t0 = Date.now();
		try { return await js(code); }
		catch (e) { stepErrors.push(label + " → " + String(e && e.message ? e.message : e)); return null; }
		finally { stepMs[label] = (stepMs[label] || 0) + (Date.now() - t0); }
	};
	// 页面里先 JSON.stringify 再返回：executeJavaScript 的返回值要结构化克隆，
	// 对象里但凡混进 DOM 节点或函数就报「An object could not be cloned」，
	// 报错还指向 Electron 内部，看不出是哪一项（2026-11-25 实测）。
	const read = async () => {
		const raw = await step("read", "JSON.stringify(" + READ + ")");
		if (typeof raw !== "string") return {};
		try { return JSON.parse(raw); } catch { return {}; }
	};
	const waitIdle = async (limit = 60000) => {
		{
			const t0 = Date.now();
			const trace = [];
			let s = await read();
			result.res.afterBreakImmediate = s;
			while (s.spin && Date.now() - t0 < 15000) {
				trace.push(Date.now() - t0 + "ms " + s.phase + " | " + (s.note || "") + " | log=" + String(s.log).slice(0, 40));
				await wait(500);
				s = await read();
			}
			result.res.afterBreakTrace = trace;
			result.res.afterBreakMs = Date.now() - t0;
			result.res.afterBreak = s;
		}
		let s = await read();
		while (s.btnDisabled && Date.now() - t0 < limit) { await wait(300); s = await read(); }
		return read();
	};

	try {
		result.res.initial = await read();
		result.res.afterScan = await waitIdle();
		// 拖动实验：用真实 mouse 事件驱动，不是直接改样式 —— 判的是「绑没绑事件」。
		await step("dragSplit", `(async () => {
			const v = document.querySelector(".vsplit");
			if (v) {
				const r = v.getBoundingClientRect();
				v.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 2, clientY: r.top + 20 }));
				document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 62, clientY: r.top + 20 }));
				document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			}
			const h = document.querySelector(".hsplit");
			if (h) {
				const r2 = h.getBoundingClientRect();
				h.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r2.left + 20, clientY: r2.top + 2 }));
				document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r2.left + 20, clientY: r2.top - 48 }));
				document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			}
			return null;
		})()`);
		await wait(300);
		result.res.afterDrag = await step("readDrag", "(function(){var cs=getComputedStyle(document.documentElement);return {sideW:cs.getPropertyValue('--side-w').trim()||null,logH:cs.getPropertyValue('--log-h').trim()||null,remembered:Boolean(localStorage.getItem('sd.sideW')&&localStorage.getItem('sd.logH'))};})()");

		// 所有页面交互都走 step：任何一步抛错都能说出是哪一步，
		// 而不会变成一条指不到位置的 fatal。
		await step("scrollBottom", "(() => { const w = document.querySelector('.vwrap'); if (w) w.scrollTop = 99999; return null; })()");
		await wait(500);
		result.res.scrolled = await read();

		await step("clickFile1", "(() => { const c = document.querySelectorAll('.card')[1]; if (c) c.click(); return null; })()");
		await wait(600);
		result.res.afterCardClick = await read();

		await step("clickSummary", "(() => { const c = document.querySelector('.card.summary'); if (c) c.click(); return null; })()");
		await wait(500);
		result.res.backToAll = await read();

		await step("pickRemove", "(() => { const b = document.querySelector('#pickAct-remove'); if (b) b.click(); return null; })()");
		await wait(500);
		result.res.afterPickRemove = await read();

		await step("pickNone", "(() => { const b = document.querySelector('#pickAll'); if (b) { if (!b.checked) b.click(); b.click(); } return null; })()");
		await wait(500);
		result.res.afterClear = await read();

		await step("pickOne", "(() => { const i = document.querySelector('.row input:not([disabled])'); if (i) i.click(); return null; })()");
		await wait(500);
		result.res.afterOnePick = await read();

		await step("askApply", "(() => { const b = document.querySelector('#btnApply'); if (b && !b.disabled) b.click(); return null; })()");
		await wait(600);
		result.res.afterApplyClick = await read();

		await step("cancel", "(() => { const b = document.querySelector('.dlg .btn'); if (b) b.click(); return null; })()");
		await wait(500);
		result.res.afterCancel = await read();

		// 部分失败：让 /apply 返回「结构判据不通过」，界面必须走黄色警告条、不能走红色连接错。
		// 这是用户真实撞到的形状（悬空 context_edit:54 被显示成「连不上本地服务」）。
		await step("fakeApplyFail", "(() => { window.__of3 = window.fetch; window.fetch = (u, o) => (String(u).indexOf('/apply') >= 0 ? Promise.resolve(new Response(JSON.stringify({ ok: false, reason: '结构判据不通过', checks: [['悬空 context_edit', false, 54]] }), { status: 200, headers: { 'content-type': 'application/json' } })) : window.__of3(u, o)); const bs = document.querySelector('#btnApply'); if (bs && !bs.disabled) bs.click(); return null; })()");
		await wait(600);
		await step("confirmApply", "(() => { const b = document.querySelector('.dlg .btn.danger'); if (b) b.click(); return null; })()");
		await wait(1500);
		result.res.afterApplyFail = await read();
		await step("restoreFetch3", "(() => { if (window.__of3) window.fetch = window.__of3; return null; })()");
		// 假 apply 那次 doApply 还在跑（它含重扫）。等它落地再做后面的动作，
		// 否则后面的点击会落在 applying 期间被丢弃 —— 那是正确行为，但测到的东西就错位了。
		result.res.afterFakeFailSettled = await waitIdle();

		// ── 重复运行：同一个动作连做多次，结果必须一致 ──
		// 用户原话：「每一个功能，重复运行的时候，都有问题，特别是前端问题很大。」
		// 下面每一步都是一个功能连做两次：数字要一样、不翻倍、不叠加、日志不被覆盖。
		await step("clearBeforeRepeat1", "(() => { const b = document.querySelector('#pickAll'); if (b) b.click(); return null; })()");
		await wait(250);
		await step("clearBeforeRepeat", "(() => { const b = document.querySelector('#pickAll'); if (b) b.click(); return null; })()");
		await wait(300);

		// ① 同一帧连点两次「重新扫描」：必须只扫一次（互斥），数字与上一次相同。
		await step("scanTwice", "(() => { const b = document.querySelector('#btnScan'); if (!b) return null; b.click(); b.click(); return null; })()");
		result.res.doubleScan = await waitIdle();
		await wait(400);
		result.res.doubleScanSettled = await read();

		// ② 再扫一次：文件数、异常数、可省量三样都必须与上一步逐字相同。
		await step("scanAgain", "(() => { const b = document.querySelector('#btnScan'); if (b) b.click(); return null; })()");
		result.res.scanAgain = await waitIdle();

		// ③ 单文件视图下批量勾选：只作用于这一个文件，按钮文案也要说明范围。
		// 挑**有可删条目**的那张卡：点一张干净文件测出来的「勾 0 == 可删 0」是同义反复。
		await step("clickFileForScope", `(() => {
	const cards = [...document.querySelectorAll('.card')].slice(1);
	const hit = cards.find((c) => {
		const m = c.querySelector('.meta');
		const s = m ? m.textContent : '';
		const n = Number((s.match(/可删 (\\d+)/) || [0, 0])[1]);
		return n > 0;
	});
	if (hit) hit.click();
	return null;
})()`);
		await wait(500);
		result.res.fileScope = await read();
		await step("pickRemoveInFile", "(() => { const b = document.querySelector('#pickAct-remove'); if (b) b.click(); return null; })()");
		await wait(300);
		result.res.pickedInFile = await read();

		// ④ 连点两次批量勾选（复选框是 toggle 语义）：第一次清空、第二次回到原样。
		await step("pickRemoveTwice1", "(() => { const b = document.querySelector('#pickAct-remove'); if (b) b.click(); return null; })()");
		await wait(250);
		result.res.pickedTwice1 = await read();
		await step("pickRemoveTwice", "(() => { const b = document.querySelector('#pickAct-remove'); if (b) b.click(); return null; })()");
		await wait(300);
		result.res.pickedTwice = await read();

		// ⑤ 连点两次「全不选」：必须是 0，且不残留。
		await step("clearTwice1", "(() => { const b = document.querySelector('#pickAll'); if (b) b.click(); return null; })()");
		await wait(250);
		await step("clearTwice", "(() => { const b = document.querySelector('#pickAll'); if (b) b.click(); return null; })()");
		await wait(300);
		result.res.clearedTwice = await read();

		// ⑥ 切回「全部会话」，再点一次进度：视图来回切多次后列表不能错位。
		await step("backToAllTwice", "(() => { const c = document.querySelector('.card.summary'); if (c) { c.click(); c.click(); } return null; })()");
		await wait(500);
		result.res.backAllTwice = await read();

		// ⑦ 真执行（沙箱副本上写盘）：勾可删 → 执行 → 确认 → 等 idle。
		await step("pickRemoveAll", "(() => { const b = document.querySelector('#pickAct-remove'); if (b) b.click(); return null; })()");
		await wait(400);
		result.res.beforeRealApply = await read();
		await step("openApplyDlg", "(() => { const b = document.querySelector('#btnApply'); if (b && !b.disabled) b.click(); return null; })()");
		await wait(500);
		result.res.applyDlg = await read();
		await step("confirmRealApply", "(() => { const b = document.querySelector('.dlg .btn.danger'); if (b) b.click(); return null; })()");
		result.res.afterRealApply = await waitIdle();
		await wait(800);
		result.res.afterRealApplySettled = await read();

		// ⑧ 执行完再执行一次：已经没有勾选，按钮必须禁用，且不发请求。
		await step("applyAgainNoPick", "(() => { const b = document.querySelector('#btnApply'); if (b && !b.disabled) b.click(); return null; })()");
		await wait(500);
		result.res.applyAgain = await read();

		// 断网：换掉 fetch 后点扫描，必须在**有限时间内**进入错误态。
		// 原来只等 2000ms 就读一次，读到的可能还是「扫描中」——那是判据没上界，
		// 不是界面没反应（2026-11-25 实测：dot=busy、stamp 还是上一次的）。
		// 改成等「不再是 scanning」，并记下等了多久；超时就是真卡住，判据据此报红。
		// 断网：换掉 fetch 后点扫描，界面必须在有限时间内进入错误态。
		//
		// 采样放在**页面里**（setInterval 记时间序列），不只靠主进程 setTimeout 读点：
		// 2026-11-25 实测主进程的 wait(500) 曾被卡到 14.6 秒（慢步判据显示 js() 都 <400ms，
		// 说明卡在主进程自己的定时器上），于是判据只看到一个陈旧的读数就报红 —— 那是测具的错。
		// 页面内采样不依赖主进程的时钟，界面到底几毫秒进 ERROR 一目了然。
		await step("breakFetch", `(() => {
	window.__of = window.fetch;
	window.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
	window.__trace = [];
	const t0 = performance.now();
	window.__timer = setInterval(() => {
		const lab = document.querySelector('#btnScanLabel');
		const dot = document.querySelector('#scanDot');
		window.__trace.push(Math.round(performance.now() - t0) + ':' + (lab ? lab.textContent : '?') + '/' + (dot ? dot.className.replace('dot', '').trim() || 'plain' : '?'));
		if (window.__trace.length > 60) clearInterval(window.__timer);
	}, 100);
	const b = document.querySelector('#btnScan');
	if (b) b.click();
	return null;
})()`);
		{
			const t0 = Date.now();
			await wait(3000);
			result.res.afterBreak = await read();
			result.res.afterBreakTrace = await step("readTrace", "JSON.stringify(window.__trace || [])");
			result.res.afterBreakAt = await step("readAt", "Math.round(performance.now())");
			result.res.afterBreakMs = Date.now() - t0;
		}
		await step("restoreFetch", "(() => { if (window.__of) window.fetch = window.__of; return null; })()");
	} catch (e) {
	result.stepErrors = stepErrors;
	result.stepMs = stepMs;
	result.slowSteps = Object.entries(stepMs).filter(([, ms]) => ms > 400).map(([k, ms]) => k + " " + ms + "ms");
		result.fatal = String(e && e.stack ? e.stack : e);
	}

	result.stepMs = stepMs;
	result.slowSteps = Object.entries(stepMs).filter(([, ms]) => ms > 400).map(([k, ms]) => k + " " + Math.round(ms) + "ms");
	write();
	app.quit();
}).catch((e) => {
	result.fatal = String(e && e.stack ? e.stack : e);
	write();
	app.quit();
});
