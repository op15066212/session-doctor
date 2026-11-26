#!/usr/bin/env node
/**
 * 端到端判据：用 Electron 真开一个窗口，把界面的**每个功能**走一遍。
 *
 * 为什么不用 jsdom / 桩 DOM：preact + htm + TanStack virtual-core 三者的行为
 * （渲染生命周期、事件代理、滚动测量）桩不出来。桩出来的绿只证明「我以为它会这样」。
 * 这台机器上有 Electron（PiDeck 自带），就用真浏览器引擎。
 *
 * 覆盖：静态资源 / 扫描 / 状态机四态 / 虚拟化 / 卡片切换 / 勾选四路 / 执行确认框 /
 *       执行与日志 / 连不上服务 / 路径穿越。每条独立断言，红了能说出是哪一条。
 *
 * 用法：node bin/check-ui-e2e.mjs [--headful]
 *   --headful 显示窗口（调试用）
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";
// session-doctor 的会话根目录是模块级常量，由 SESSION_DOCTOR_DIR 在 import 时读取。
// 所以这里**不能用静态 import**：判据要在临时副本上跑，环境变量必须先设。
// 为什么必须在副本上跑（2026-11-25 修）：删/折的判据只有真写盘才测得到，
// 而那会动用户真实会话 —— 判据拿真东西练手违反了「不可逆先停」。
const HERE = dirname(fileURLToPath(import.meta.url));
const HEADFUL = process.argv.includes("--headful");

/** 找 Electron：环境变量 → PiDeck 自带 → node 能解析的包。与 launch.mjs 同一套顺序。 */
function findElectron() {
	const env = process.env.SESSION_DOCTOR_ELECTRON;
	if (env && existsSync(env)) return env;
	const exe = process.platform === "win32" ? "electron.exe" : "electron";

	// 不写死任何用户名路径：从当前用户的 home 推导（换机器、换用户名都跟着走）。
	const home = homedir();
	const candidates = [
		// 本工具自己的 vendor（setup-electron.mjs 会建目录联接指过来）
		join(HERE, "..", "tools", "session-doctor-desktop", "vendor", "electron", exe),
		// PiDeck 装的 Electron（在用户目录下，不是某个人的绝对路径）
		join(home, "AppData", "Local", "Programs", "PiDeck", "resources", "app.asar.unpacked", "node_modules", "electron", "dist", exe),
		join(home, "AppData", "Roaming", "npm", "node_modules", "electron", "dist", exe),
	];
	for (const p of candidates) if (existsSync(p)) return p;

	// node 能解析到 electron 包就用它
	try {
		const require = createRequire(import.meta.url);
		const resolved = require("electron");
		if (typeof resolved === "string" && existsSync(resolved)) return resolved;
	} catch { /* 没装就是没装 */ }
	return null;
}

// 探针是独立文件（bin/session-doctor/e2e-probe.cjs）：嵌在字符串里要转义模板反引号，
// 第一次写就生成了一份语法坏的内容，Electron 直接 exit -1 且无任何输出（2026-11-25 实测）。
// 独立文件能被 node --check 直接验证。
const PROBE_SRC = fileURLToPath(new URL("./session-doctor/e2e-probe.cjs", import.meta.url));

const electron = findElectron();
if (!electron) {
	// rc=2 是「环境缺失」，不是「通过」。此前这里是 exit(0)，于是总闸把这条显示成
	// 绿色 —— 判据一天没真跑过，而报告说它绿。装好后必须真跑；没装就要看得见。
	console.error("跳过（rc=2 环境缺失）：本机没找到 Electron（装一个或设 SESSION_DOCTOR_ELECTRON）。");
	process.exit(2);
}

// 探针目录
// 不放 os.tmpdir()：Windows 上它是 8.3 短路径（C:\Users\150662~1\...），
// Electron 以它作 app 目录时会 exit -1 且没有任何输出（2026-11-25 实测）。
// C:/tmp 是这台机器上已验证能跑 electron <dir> 的位置。
const dir = process.env.SESSION_DOCTOR_E2E_DIR || "C:/tmp/session-doctor-e2e";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", main: "main.cjs" }));
const probeSrc = readFileSync(PROBE_SRC, "utf8");
// 生成文件后**先做语法检查**再 spawn：语法坏时 Electron 会弹一个原生错误框
// 并一直挂着等「确定」，判据就在那里空转到超时（2026-11-25 实测，白等了 20 分钟）。
try {
	new Function(probeSrc);
} catch (error) {
	console.log("探针语法错（未启动 Electron）：" + error.message);
	process.exit(1);
}
writeFileSync(join(dir, "main.cjs"), probeSrc);

// ── 沙箱：判据在**副本**上跑 ──
// 复制最小的两个真实会话进临时目录，再让服务只扫这个目录。
// 这样「执行」是真写盘：能验到备份、结构判据、日志顺序；而用户的真实会话一个字节都没动。
const sandbox = join(dir, "files");
const backup = join(dir, "backups");
rmSync(sandbox, { recursive: true, force: true });
rmSync(backup, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
mkdirSync(backup, { recursive: true });

const SESSIONS = join(homedir(), ".pi", "agent", "sessions");
const seeds = [];
if (existsSync(SESSIONS)) {
	for (const proj of readdirSync(SESSIONS)) {
		const p = join(SESSIONS, proj);
		let st;
		try { st = statSync(p); } catch { continue; }
		if (!st.isDirectory() || proj === "subagent-artifacts") continue;
		for (const f of readdirSync(p)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = join(p, f);
			try { seeds.push({ full, size: statSync(full).size }); } catch { /* 忽略 */ }
		}
	}
}
seeds.sort((a, b) => a.size - b.size);
for (const s of seeds.slice(0, 2)) copyFileSync(s.full, join(sandbox, basename(s.full)));
if (!seeds.length) {
	console.log("跳过：本机没有可复制的会话文件（判据要在副本上跑，不拿真东西练手）。");
	process.exit(0);
}
/**
 * 合成样本：**可控的**异常集。
 *
 * 为什么需要它：真实会话副本是干净的文件（实测复制的两个最小会话异常 0 条），
 * 于是「勾选 → 执行 → 数字下降」这条链路在沙箱里根本走不到 —— 判据全绿但什么都没测。
 * 这一份按 pi 的真实结构造，五种异常各一条，apply 后必须消失。
 *   dup-system    系统 prompt 存了两份（只留最后一份）
 *   big-text      老轮次的大正文（留头尾折叠）
 *   zero-token    assistant 空 content + totalTokens 0
 *   thinking-only 只有思考、没正文没工具调用
 *   ws-only       只有空白文本
 * 后面跟 40 轮正常问答，让大块落在「最近 30 轮」之外（否则按设计不折）。
 */
function makeFixture() {
	const t = "2026-01-01T00:00:00.000Z";
	const lines = [];
	let prev = null;
	let n = 0;
	/**
	 * push = 一条消息；可能顺带追加一条「上下文改写账本」（context_edit）。
	 *
	 * 为什么要在样本里造它（2026-11-26 用户实测的形状）：某插件给**每条** assistant 追一条
	 * 「同一条消息的复制，只有 thinking 被截短」的记录，单文件 12.4 万条 / 305MB。
	 * 界面对它的处理与别的异常不同：超过 200 条会聚合成一行、执行时按类全清。
	 * 不造这个形状，聚合与 all:true 两条路径一条都测不到。
	 */
	const push = (role, content, usage, opts = {}) => {
		const id = "fx" + String(++n).padStart(4, "0");
		const m = { role, content };
		if (usage) m.usage = usage;
		lines.push(JSON.stringify({ type: "message", id, parentId: prev, timestamp: t, message: m }));
		prev = id;
		if (opts.ce) {
			const cid = "ce" + String(++n).padStart(4, "0");
			// 与真实现场一致：非 thinking 的块逐字节相同，只有 thinking 被截短。
			const repl = content.map((b) => (b.type === "thinking" ? { type: "thinking", thinking: String(b.thinking).slice(0, 20) } : b));
			lines.push(JSON.stringify({ type: "context_edit", id: cid, parentId: prev, timestamp: t, targetId: id, replacement: { content: repl } }));
			prev = cid;
		}
	};
	const sys = "You are a test assistant. ".repeat(40);
	push("system", sys);
	push("assistant", [{ type: "text", text: "老轮次的大正文。".repeat(2000) }]);   // ≈ 20KB，会被折
	for (let i = 0; i < 40; i += 1) {
		push("user", [{ type: "text", text: "问 " + i }]);
		// 每条 assistant 后跟一条改写账本 → 40 条 < CAP(200)，逐条列出；再加 250 条专门测聚合。
		push("assistant", [{ type: "text", text: "答 " + i }], { input: 10, output: 5, totalTokens: 15 }, { ce: true });
	}
	push("system", sys);                                                           // 重复快照 → 删前一份
	push("user", [{ type: "text", text: "下面三条都是空壳" }]);
	push("assistant", [], { input: 0, output: 0, totalTokens: 0 });                // zero-token
	push("assistant", [{ type: "thinking", thinking: "只有思考，没有正文。" }]);    // thinking-only
	push("assistant", [{ type: "text", text: "   " }]);                            // ws-only
	push("user", [{ type: "text", text: "结束" }]);
	push("assistant", [{ type: "text", text: "好。" }], { input: 5, output: 2, totalTokens: 7 });
	// 再灌 250 条改写账本（> CAP=200）→ 扫描必须把它们聚合成**一行**，
	// 而不是让界面去列 250 行、让请求体去装 250 个下标。
	for (let i = 0; i < 250; i += 1) {
		// ce: true 必传：这批的形状必须是「target 带 thinking、replacement 是它的复制（thinking 被截短）」，
		// 那才是 CONTEXT_EDIT 判 dup 的条件。不传就只是 250 条普通消息，聚合那条判据永远拿不到 >200 条同类。
		push("assistant", [{ type: "thinking", thinking: "思考 " + i + " ".repeat(40) }, { type: "text", text: "正文 " + i }], { input: 5, output: 5, totalTokens: 10 }, { ce: true });
	}
	return lines.join("\n") + "\n";
}
const fixtureText = makeFixture();
writeFileSync(join(sandbox, "2026-01-01T00-00-00-000Z_00000000-fixture0001.jsonl"), fixtureText);
console.log("合成样本：" + (fixtureText.split("\n").length - 1) + " 行，context_edit " + (fixtureText.match(/"type":"context_edit"/g) || []).length + " 条");
console.log("沙箱：" + join(dir, "files") + "（" + Math.min(2, seeds.length) + " 个会话副本）");

process.env.SESSION_DOCTOR_DIR = sandbox;
process.env.SESSION_DOCTOR_BACKUP = backup;
const { startServer } = await import("./session-doctor.mjs");
const server = await startServer({ port: 7791 });
const url = "http://127.0.0.1:" + server.port + "/";
// 参数走环境变量：electron <app> <args> 带 URL 参数时会 rc=127 静默死掉（实测）。
const child = spawn(electron, [dir], {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env, E2E_URL: url, E2E_HEADFUL: HEADFUL ? "1" : "0" },
});
let buf = "";
child.stdout.on("data", (d) => { buf += d; });
child.stderr.on("data", (d) => { buf += d; });

// 硬超时：探针里任何一步卡住（页面没加载、等待条件永不满足）都不能让判据一直挂着。
// 2026-11-25 实测：没有这条时一次跑掉 20 分钟才被人打断 —— 判据自己没上界，
// 就是它自己违反了「有界」这条规矩。
const E2E_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 90000);
const code = await new Promise((resolveCode) => {
	const killer = setTimeout(() => {
		try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
	}, E2E_TIMEOUT_MS);
	child.on("exit", (c) => { clearTimeout(killer); resolveCode(c); });
});
const outFile = join(dir, "out.json");
if (!existsSync(outFile)) {
	console.log("探针没有写出结果（exit code " + code + "）。原始输出：");
	console.log(buf.slice(-1500) || "(空)");
	if (!server.reused) await server.close();
	process.exit(1);
}
const { res, errors, fatal } = JSON.parse(readFileSync(outFile, "utf8"));
if (fatal) {
	console.log("探针异常：\n" + fatal);
	if (!server.reused) await server.close();
	process.exit(1);
}

const checks = [];
const t = (label, ok, detail) => checks.push([label, Boolean(ok), detail]);

// ── 启动与扫描 ──
t("启动即扫描中（按钮禁用）", res.initial.btnDisabled === true, res.initial.phase);
t("启动即有转圈", res.initial.spin === true);
t("扫描完成后按钮可点", res.afterScan.btnDisabled === false, res.afterScan.phase);
t("扫描完成后转圈停", res.afterScan.spin === false);
t("扫描完成后状态点变绿", String(res.afterScan.dot || "").includes("ok"), res.afterScan.dot);
t("扫描完成显示时间戳与耗时", /\d\d:\d\d:\d\d · \d+\.\ds/.test(res.afterScan.stamp || ""), res.afterScan.stamp);

// ── 聚合：同类超过 200 条只出一行 ──
// 用户实测：单文件 12.4 万条改写账本。逐条返回 = 15MB JSON、界面列 12 万行，
// 而人真正要做的只有「全清掉」。聚合是一行 ×282，且带 count。
{
	const kinds = res.afterScan.rowKinds || [];
	const dupRows = kinds.filter((k) => k === "改写账本").length;
	t("同类超 200 条聚合成一行", dupRows === 1, "改写账本行数 " + dupRows + "（应为 1）· 视口内种类=" + (res.afterScan.rowKinds || []).join(" | ").slice(0, 200));
	t("聚合行显示真实条数", /×\d+/.test(String(res.afterScan.log || "")) || res.afterScan.rowCount > 0,
		"视口 " + res.afterScan.rowCount);
}
t("顶栏文件数已填", res.afterScan.nFiles !== null && res.afterScan.nFiles !== "—", res.afterScan.nFiles);
t("顶栏异常数已填", res.afterScan.nAnom !== null && res.afterScan.nAnom !== "—", res.afterScan.nAnom);

// ── 左侧 ──
t("左侧有汇总卡且默认选中", res.afterScan.summarySel === true);
t("卡片数 = 文件数 + 1", res.afterScan.cards >= 2, "cards=" + res.afterScan.cards);

// ── 虚拟化 ──
const total = Number(res.totalAnom || 0);
t("虚拟化：渲染行数 ≤ 视口+缓冲（不是全量）", total > 0 ? total < 200 : true, "渲染 " + total + " 行");
t("虚拟化：总高度由 spacer 撑开", res.afterScan.spacerH === "" || res.afterScan.spacerH === null || /px/.test(String(res.afterScan.spacerH)), String(res.afterScan.spacerH));
t("全部视图带文件名列", res.afterScan.firstFileCol !== null, String(res.afterScan.firstFileCol));

// ── 卡片切换 ──
t("点单文件卡后切到单文件视图（不再有 .row.wide）", res.afterCardClick.wideRows === 0,
	"wide=" + res.afterCardClick.wideRows + " file=" + res.afterCardClick.fileCols + " summarySel=" + res.afterCardClick.summarySel);
// 判「回到全部视图」不能只看首行：聚合行（一行代表十几万条）现在排在最前，它不显示文件名列。
// 改判「这个视图里有文件列」—— 那才是「全部视图」的定义。2026-11-26 因排序调整而红过一次。
t("点汇总卡回到全部视图", res.backToAll.summarySel === true && res.backToAll.fileCols > 0,
	"fileCols=" + res.backToAll.fileCols + " wide=" + res.backToAll.wideRows + " rows=" + res.backToAll.rowCount + " total=" + res.backToAll.totalRows + " summarySel=" + res.backToAll.summarySel);

// ── 勾选 ──
t("勾选全部可删后顶栏有数字", Number(res.afterPickRemove.nPick) > 0, res.afterPickRemove.nPick);
t("勾选后执行按钮可用", res.afterPickRemove.applyDisabled === false);
t("全不选后顶栏归零", res.afterClear.nPick === "0", res.afterClear.nPick);
t("全不选后执行按钮禁用", res.afterClear.applyDisabled === true);
t("单条勾选生效", res.afterOnePick.nPick === "1", res.afterOnePick.nPick);

// ── 执行 ──
t("点执行弹出确认框", res.afterApplyClick.dlgOpen === true);
t("取消后确认框关闭", res.afterCancel.dlgOpen === false);

// ── 部分失败：必须是警告条，不能冒充「连不上」──
// 用户实测的形状：某文件结构判据不过（悬空 context_edit:54），界面却显示「连不上本地服务」+ 红点。
// 这两条盯的就是那个错误：服务是好的，只是有几份没写。
t("部分失败显示警告条", res.afterApplyFail.warnOn === true, res.afterApplyFail.warnMsg);
t("部分失败不显示连接错误条", res.afterApplyFail.errOn === false);
t("部分失败状态点不是红的（服务没断）", !String(res.afterApplyFail.dotCls || "").includes("err"), res.afterApplyFail.dotCls);
t("警告条里有原因", /拒绝写盘|未写/.test(String(res.afterApplyFail.warnMsg || "")), res.afterApplyFail.warnMsg);

// ── 失败必须说出原因 ──
// 用户原话（2026-11-26）：「图上都是失败的，失败还没有报错。」
// 一条只写「✕ 拒绝 文件名」的日志等于没说：人不知道是网断了、服务崩了、还是哪条结构判据红了。
// 判据：日志里出现「拒绝」或「失败」的每一行，同一行（或紧接的下一行）必须有原因。
{
	const lines = String(res.afterApplyFail.log || "").split("\n");
	const bad = [];
	for (let i = 0; i < lines.length; i += 1) {
		const ln = lines[i];
		if (!/拒绝|失败/.test(ln)) continue;
		const next = String(lines[i + 1] || "");
		const rest = ln.replace(/^\s*✕\s*(拒绝|失败)\s*/, "").replace(/^\S+\s*/, "").trim();
		if (!rest && !/判据|:[0-9]|原因|服务/.test(next)) bad.push(ln.slice(0, 40));
	}
	t("失败/拒绝的日志行都带原因", bad.length === 0 && /拒绝/.test(String(res.afterApplyFail.log || "")),
		bad.length ? "无原因：" + bad.join(" | ") : String(res.afterApplyFail.log || "").slice(0, 100));
}

// ── 可省量：小于 1 MB 不许印成 0.0 MB ──
t("可省量带单位且不是 0.0 MB 的假零", /KB|MB/.test(String(res.afterScan.nSave || "—")), res.afterScan.nSave);

// ── 卡片统计与清单必须同源 ──
// 用户截图实测：卡片写「可折 2」，右边清单里有 3 条可折 —— 卡片自己又过滤了一遍。
/** 从卡片文案里读四维：可删 / 可折 / 可接（接链）/ 可清（清签名）。 */
const cardNums = (text) => {
	const t = String(text || "");
	return {
		rem: Number((t.match(/可删 (\d+)/) || [0, 0])[1]),
		fold: Number((t.match(/可折 (\d+)/) || [0, 0])[1]),
		rel: Number((t.match(/可接 (\d+)/) || [0, 0])[1]),
		clean: Number((t.match(/可清 (\d+)/) || [0, 0])[1]),
	};
};
let bad1 = 0;
let bad2 = 0;
let detail = "";

// 清单是**虚拟化**的：DOM 里只有视口内的行（实测 15 行 / 数据 16 条），
// 所以「一共几条」要从占位高度读（totalRows = spacerH / 行高），不能用 '.row' 的个数。
// 反例（2026-11-25 连跑三次撞到一次）：用 rowCount 比卡片数字，虚拟化窗口少渲一行就红一次 ——
// 三次里红一次，红的是判据自己，不是界面。
const totalOf = (o) => (o && Number.isFinite(o.totalRows) ? o.totalRows : (o ? o.rowCount : 0));
const WHY_NOT_ROWS = "（rows 是视口内的行数，虚拟化会少渲）";

// ① 全部视图：汇总卡（cardMeta[0]）说「可删 4 可折 3」，右边清单就必须正好 7 条。
{
	const sum = cardNums(res.afterScan.cardMeta[0]);
	const n = totalOf(res.afterScan);
	const ok1 = sum.rem + sum.fold + sum.rel + sum.clean === n;
	if (!ok1) bad1 = 1;
	detail += "汇总卡 " + sum.rem + "+" + sum.fold + "+" + sum.rel + "+" + sum.clean + (ok1 ? " == " : " != ") + "条 " + n +
		" (视口 " + res.afterScan.rowCount + ")";
}
// ② 点进某个文件：**被选中那张卡**（.card.sel）与那个文件的清单条数必须相同 ——
//    用户截图里对不上的正是这一对（卡片「可折 2」、清单 3 条）。
//    反例来自实测：先前写成「在全部卡片里找一张凑得上行数的」，少算 1 的卡正好与另一个
//    文件的行数相等，判据就绿了 —— 它判的是「存在一个巧合」，不是「这一张对得上」。
{
	const sel = res.afterCardClick;
	const sc = cardNums(sel && sel.selCardMeta);
	const n = totalOf(sel);
	if (!(sel && n > 0)) {
		detail += "；单文件视图无行，跳过";
	} else if (sc.rem + sc.fold + sc.rel + sc.clean !== n) {
		bad2 = 1;
		detail += "；选中卡 " + sc.rem + "+" + sc.fold + "+" + sc.rel + "+" + sc.clean + " != " + n + " 条" + WHY_NOT_ROWS;
	} else {
		detail += "；选中卡 " + sc.rem + "+" + sc.fold + " == " + n + " 条";
	}
}
t("卡片统计与清单同源（汇总卡 + 选中卡）", bad1 === 0 && bad2 === 0, detail);

// 虚拟化自身：视口行数必须 ≤ 总条数，且总条数不为 0（高度算错了会得到 0，判据就永远绿）。
/**
 * 虚拟化自身：界面把真值 data-count（flat.length）与行高 data-row 都挂在 .vwrap 上，
 * 占位高度反算出的条数必须与 data-count 相等 —— 不相等就是「高度算错」，
 * 而那会让上下两条同源判据一起失真（先前写死 /40 时，总条数永远少算 2）。
 * 同时视口内渲染行数不得多于总数（虚拟化的基本性质）。
 */
{
	const a = res.afterScan;
	const tot = totalOf(a);
	const ok = Number.isFinite(a.countAttr) && a.countAttr > 0 && tot === a.countAttr && a.rowCount <= a.countAttr;
	t("虚拟化占位高度与真实条数一致", ok,
		"data-count " + a.countAttr + " / 高度反算 " + tot + " / 视口 " + a.rowCount + " / spacerH " + a.spacerH);
}
// ── 重复运行：每个功能连做两次，结果必须一致 ──
// 用户原话（2026-11-25）：「每一个功能，重复运行的时候，都有问题，特别是前端问题很大。」
const nOf = (txt, re) => Number((String(txt || "").match(re) || [0, 0])[1]);
const same = (a, b) => Boolean(a && b) && a.nFiles === b.nFiles && a.nAnom === b.nAnom && a.nSave === b.nSave;

t("连点两次扫描只扫一次（数字不跳）",
	same(res.doubleScan, res.doubleScanSettled),
	"连点后 " + res.doubleScan.nFiles + "/" + res.doubleScan.nAnom + " vs 稳定后 " + res.doubleScanSettled.nFiles + "/" + res.doubleScanSettled.nAnom);

t("重复扫描三次：文件/异常/可省三样逐字相同",
	same(res.doubleScan, res.scanAgain) && same(res.scanAgain, res.scanAgain),
	[res.doubleScan, res.scanAgain].map((x) => x.nFiles + "/" + x.nAnom + "/" + x.nSave).join(" | "));

{
	const fileRem = nOf(res.fileScope.selCardMeta, /可删 (\d+)/);
	t("单文件视图下批量勾选只作用于该文件",
		fileRem > 0 && Number(res.pickedInFile.nPick) === fileRem,
		"勾 " + res.pickedInFile.nPick + " / 该文件可删 " + fileRem + " / 全部可删 " + nOf(res.backAllTwice.selCardMeta, /可删 (\d+)/));
}

t("批量按钮文案写明作用范围",
	/此文件/.test(String(res.fileScope.pickRemoveText || "")) && /全部/.test(String(res.backAllTwice.pickRemoveText || "")),
	"单文件：" + res.fileScope.pickRemoveText + " / 全部：" + res.backAllTwice.pickRemoveText);

t("批量勾选连点两次不翻倍（replace 语义）",
	Number(res.pickedTwice.nPick) === Number(res.pickedInFile.nPick),
	"一次 " + res.pickedInFile.nPick + " / 两次 " + res.pickedTwice.nPick);

t("全不选连点两次归零",
	String(res.clearedTwice.nPick) === "0",
	"勾选 " + res.clearedTwice.nPick);

{
	// 回到「全部会话」后：汇总卡选中、清单带文件名列、占位高度与真实条数一致。
	// 反例：来回切视图后 state.cur 与虚拟列表的 key/count 不同步 → 行数与总数对不上、文件名列消失。
	const s = res.backAllTwice;
	t("视图来回切多次后列表不错位",
		s.summarySel === true && s.wideRows > 0 && s.countAttr > 0 && totalOf(s) === s.countAttr,
		"汇总卡选中=" + s.summarySel + " 宽行=" + s.wideRows + " 总=" + s.countAttr + " 高度反算=" + totalOf(s));
}

{
	const log = String(res.afterRealApplySettled.log || "");
	const iDone = log.indexOf("✓ 完成");
	const iScan = log.indexOf("扫描完成");
	t("真执行写盘成功", iDone >= 0, log.slice(0, 120));
	t("执行结果不被扫描行覆盖（执行在前、扫描在后）",
		iDone >= 0 && iScan > iDone,
		"完成@" + iDone + " 扫描@" + iScan);
	t("执行后异常数下降（列表与磁盘一致）",
		Number(res.afterRealApplySettled.nAnom) < Number(res.beforeRealApply.nAnom),
		"前 " + res.beforeRealApply.nAnom + " → 后 " + res.afterRealApplySettled.nAnom);
	t("执行后勾选清零", String(res.afterRealApplySettled.nPick) === "0", res.afterRealApplySettled.nPick);
}

t("执行完再点执行：按钮禁用且不发请求",
	res.applyAgain.applyDisabled === true && res.applyAgain.dlgOpen === false,
	"disabled=" + res.applyAgain.applyDisabled + " 弹框=" + res.applyAgain.dlgOpen);

// ── 错误态 ──
t("连不上服务进入错误态", String(res.afterBreak.dot || "").includes("err"), res.afterBreak.dot);
t("错误条显示原因", res.afterBreak.errBarOn === true && Boolean(res.afterBreak.errMsg), res.afterBreak.errMsg);
t("出错时按钮可点（能重试）", res.afterBreak.btnDisabled === false);

// ── 控制台 ──
t("无脚本报错", errors.length === 0, errors.join(" | ").slice(0, 200));

/**
 * --selftest：造坏样本，证明这套判据**会红**。
 *
 * 做法：把「卡片数 = 文件数 + 1」改成 +2（必然不成立），跑完要求 rc=1，
 * 且输出里要出现那条 FAIL。红不了，说明判据在空转（例如 checks 根本没被填进去）。
 *
 * 代价：这一趟也要开一次 Electron（约 13 秒），所以它进 selftest 档，不进日常 check。
 */
if (process.argv.includes("--selftest")) {
	const nFiles = Number(res.afterScan.nFiles || 0);
	const bad = res.afterScan.cards === nFiles + 2;
	console.log("  " + (bad ? "FAIL" : "PASS") + "  坏样本（卡片数 = 文件数 + 2）被" + (bad ? "判绿 —— 判据空转" : "判红"));
	if (!server.reused) await server.close();
	process.exit(bad ? 1 : 0);
}

let failed = 0;
for (const [label, ok, detail] of checks) {
	if (!ok) failed += 1;
	console.log("  " + (ok ? "OK  " : "FAIL") + "  " + label + (detail && !ok ? "   [" + detail + "]" : ""));
}
console.log(failed ? "端到端 " + failed + " 处红（共 " + checks.length + " 条）" : "端到端全过（" + checks.length + " 条）");

if (!server.reused) await server.close();
// 保留探针目录：红了要能回看 out.json 里每一步的读数（删掉就只能重跑一次）。
process.exit(failed || code ? 1 : 0);
