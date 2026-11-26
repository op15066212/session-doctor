#!/usr/bin/env node
/**
 * 会话医生：本地网页界面，扫描并清理会话异常。
 *
 * 为什么是「本地 http + 浏览器」而不是 Electron：这一件事只有一张表和一个勾选框，
 * 起一个 Electron 进程要 100MB+ 与独立打包，而 pi 自带 Node；用零依赖的 http 起一个
 * 只监听 127.0.0.1 的服务，按一次就走。界面要「虚拟化」是因为异常清单可能上万条
 * （13 万条 context_edit 那种会话），DOM 全量渲染会卡死。
 *
 * 判定规则不在这里：全部来自 bin/lib/session-fix.mjs（与 prune-session / fold-session 同一处）。
 * 这个文件只做三件事：起服务、把扫描结果转成 JSON、把勾选交给 lib 执行。
 *
 * 安全：
 *   - 只监听 127.0.0.1，令牌在 URL 里（其它本机进程不知道这个 URL）
 *   - 只接受 /api/apply 里**扫描结果中出现过的**文件路径（path 必须属于扫描根目录）
 *   - 每次执行前整份备份；结构判据不过就拒绝写盘
 * 用法：node bin/session-doctor.mjs [--dir 会话根] [--port 7788] [--backup 备份目录] [--no-open] [--new]
 *
 * **通用性**：不写死任何绝对路径。默认从当前用户推导
 *   ~/.pi/agent/sessions      （pi 的会话根，下面每个项目一个子目录）
 *   ~/.pi/agent/.session-backups
 * 换机器、换盘、换用户名都跟着走；要指别处用 --dir / 环境变量 PI_AGENT_HOME、SESSION_DOCTOR_DIR。
 *
 * 反复打开是常态（2026-11-25 用户原话：「我可能会反复打开」），所以：
 *   1. 已在跑就直接复用：先探 /api/ping，活着就只把浏览器指过去然后退出，不起第二个服务。
 *      旧版撞上 EADDRINUSE 直接抛整段栈，窗口停在「Press any key」，人以为工具坏了。
 *   2. 端口固定 7788 不随机（用户原话：「不要随机，我本地使用，很安全」）；被别的程序占就如实报。
 * 桌面版（tools/session-doctor-desktop）复用同一个 startServer，另加一层 Electron 单实例锁。
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, resolve, sep, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { readSession, findAnomalies, applyChosen, applyFold, measure, verify, writeWithBackup, KIND, REMOVABLE, FOLDABLE, RELINKABLE, CLEANABLE, DEFAULTS, applyRelink, applyClean, pruneBackups } from "./lib/session-fix.mjs";

const args = process.argv.slice(2);
const pickArg = (name, dflt) => {
	const i = args.indexOf("--" + name);
	return i >= 0 ? args[i + 1] : dflt;
};

/**
 * 路径全部从**当前用户与当前盘**推导，不写死任何绝对路径。
 * 换机器、换盘、换用户名，只要 pi 装在标准的 ~/.pi/agent，这里就跟着走。
 * 三种覆盖，优先级从高到低：命令行参数 > 环境变量 > 推导默认值。
 *
 * 为什么要推导而不是配置：写死的 C:/Users/<用户名>/... 换一台机器就是死路径，
 * 而「会话在哪」这件事 pi 自己已经定了（~/.pi/agent/sessions），再抄一份就是第二个像。
 */
const PI_HOME = process.env.PI_AGENT_HOME || join(homedir(), ".pi", "agent");
/** 同类异常超过这么多条就聚合成一行（见 scanAll 的注释）。 */
const SAME_KIND_CAP = 200;
/** 不是 pi 会话、但躺在 sessions 目录里的子目录：子代理运行记录、异步任务中间件。
 *  判据：bin/check-scan-scope.mjs 放一个这样的目录，断言它不出现在扫描结果里。 */
const NOT_SESSIONS = new Set(["subagent-artifacts", "subagents", "pi-async"]);
const SESSIONS_ROOT = pickArg("dir", process.env.SESSION_DOCTOR_DIR || join(PI_HOME, "sessions"));
const PORT = Number(pickArg("port", process.env.SESSION_DOCTOR_PORT || 7788));
const NO_OPEN = args.includes("--no-open");
const BACKUP_ROOT = pickArg("backup", process.env.SESSION_DOCTOR_BACKUP || join(PI_HOME, ".session-backups"));
/** 前端目录：结构与样式与逻辑全在这里，后端只服务文件 + 三个 API（前后端分离）。 */
const UI_DIR = fileURLToPath(new URL("./session-doctor/", import.meta.url));
const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

/** 口径上限：递归深度 2（sessions/<项目>/<文件>），文件数上限 500。超过就报数并截断，不静默。 */
const MAX_DEPTH = 2;
const MAX_SESSION_FILES = 500;

/**
 * 扫会话文件。pi 的布局是 sessions/<项目编码>/<会话>.jsonl，但直接指向某一个项目目录
 * （--dir <项目>）也认——那时该目录自己的名字就是项目名。
 */
function listFiles() {
	if (!existsSync(SESSIONS_ROOT)) return [];
	const out = [];
	const walk = (dir, depth) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const d of entries) {
			const p = join(dir, d.name);
			if (d.isDirectory()) {
				// 点开头的目录是归档/回收（.pideck-archive、.trash），不参与。
				// NOT_SESSIONS 里的目录放的是子代理运行记录与异步中间件，格式与 pi 会话不同
				// （没有 id / parentId / type）。2026-11-26 实测：它们被当成会话扫进来，
				// 报出「思考签名」，执行时按 id 找不到目标，删除那一步却按下标把它们删了。
				if (NOT_SESSIONS.has(d.name)) continue;
				if (depth < MAX_DEPTH && !d.name.startsWith(".")) walk(p, depth + 1);
				continue;
			}
			if (!d.name.endsWith(".jsonl")) continue;
			let size = 0;
			try { size = statSync(p).size; } catch { continue; }
			out.push({ path: p, name: d.name, size, project: projectOf(p) });
		}
	};
	walk(SESSIONS_ROOT, 0);
	if (out.length > MAX_SESSION_FILES) {
		console.error("会话文件 " + out.length + " 个，超过上限 " + MAX_SESSION_FILES + "，只处理最大的 " + MAX_SESSION_FILES + " 个");
	}
	return out.sort((a, b) => b.size - a.size).slice(0, MAX_SESSION_FILES);
}

/** 项目标签：会话文件所在的上一级目录名（原样，不猜路径）。 */
function projectOf(file) {
	const parts = file.split(/[\\/]/);
	const dir = parts[parts.length - 2] || "";
	if (!dir) return "(根)";
	// **不试着还原成路径**：pi 把路径编码成 --c--users-x-appdata-roaming-pideck-chat-workspace--，
	// 分隔符和名字里的连字符是同一个字符（chat-workspace），split("-") 会把它拆成 chat\workspace。
	// 猜出来的路径是错的，比不显示更坏。显示原名，UI 里截断、title 给全文。
	return dir;
}

async function scanAll() {
	const out = [];
	for (const f of listFiles()) {
		const { lines, entries } = await readSession(f.path);
		const raw = findAnomalies(entries);
		/**
		 * 同类超过 SAME_KIND_CAP 条就折叠成**一条聚合项**。
		 *
		 * 为什么（2026-11-26 实测）：某插件给每条 assistant 追加了一条上下文改写账本，
		 * 单个文件 12.4 万条。逐条返回 = /api/scan 一次吐 15MB JSON，界面列 12 万行，
		 * 而人真正要做的只有一件事：全清掉。聚合项的 entry = -1（不是合法下标），
		 * 执行时带 all:true，服务端自己重新判定该类全部 —— 请求体小，语义不变。
		 */
		const grouped = new Map();
		for (const a of raw) {
			if (!grouped.has(a.kind)) grouped.set(a.kind, []);
			grouped.get(a.kind).push(a);
		}
		const anomalies = [];
		for (const [kind, list] of grouped) {
			if (list.length <= SAME_KIND_CAP) { anomalies.push(...list); continue; }
			anomalies.push({
				entry: -1, block: null, kind, count: list.length,
				bytes: list.reduce((n, a) => n + a.bytes, 0),
				aggregate: true,
				why: list[0].why + "（共 " + list.length + " 条，逐条列出没有意义）",
			});
		}
		out.push({
			path: f.path, name: f.name, project: f.project,
			sizeMB: +(f.size / 1048576).toFixed(1),
			entries: entries.length,
			anomalies,
			saveBytes: anomalies.reduce((n, a) => n + a.bytes, 0),
		});
	}
	return out;
}


function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let raw = "";
		req.on("data", (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) reject(new Error("请求体过大")); });
		req.on("end", () => resolveBody(raw));
		req.on("error", reject);
	});
}

/**
 * 建服务实例，**不监听**。CLI 与桌面版共用这一份 handler —— 两份 handler 就是两份判据口径，
 * 迟早一个改了另一个没改（这一族错今天已经犯过一次：界面与两个 CLI 的判定分叉）。
 */
export function createDoctorServer() {
	return createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const json = (code, obj) => {
		res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(obj));
	};
	try {
		// 令牌已去掉（2026-11-25 用户原话：「不要随机，我本地使用，很安全」）。
		// 反复打开时「刷新后 URL 丢令牌变 403」是自己给自己找的麻烦；只监听 127.0.0.1，
		// 且路径校验仍在（只接受会话目录下的 .jsonl），防的是手误不是外人。
		// 静态文件：前端是独立目录（index.html / app.css / *.js / vendor/），
		// 后端只按请求路径读盘，不再内联 HTML。前后端分离在这一行体现。
		if (!url.pathname.startsWith("/api/")) {
			const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
			// normalize 之后必须仍在 UI_DIR 内：挡掉 ../ 穿越（防手误，不是防外人）。
			const full = normalize(join(UI_DIR, rel));
			if (!full.startsWith(normalize(UI_DIR)) || !existsSync(full) || statSync(full).isDirectory()) {
				json(404, { ok: false, reason: "no such file: " + rel });
				return;
			}
			const ext = full.slice(full.lastIndexOf("."));
			res.writeHead(200, {
				"content-type": MIME[ext] || "application/octet-stream",
				// 本地工具，改了文件刷新就要看到；不缓存省掉「改了没生效」的排查。
				"cache-control": "no-store",
			});
			res.end(readFileSync(full));
			return;
		}
		// 探活：第二次双击靠它判断「已经在跑的那一个」。故意不读盘、不扫描，毫秒级。
		if (url.pathname === "/api/ping") {
			json(200, { ok: true, app: "session-doctor", dir: SESSIONS_ROOT, backup: BACKUP_ROOT, pid: process.pid });
			return;
		}
		if (url.pathname === "/api/scan") {
			const t = Date.now();
			const files = await scanAll();
			console.log("扫描 " + files.length + " 个文件，用时 " + (Date.now() - t) + "ms");
			json(200, files);
			return;
		}
		if (url.pathname === "/api/apply" && req.method === "POST") {
			const body = JSON.parse(await readBody(req));
			const target = resolve(String(body.path || ""));
			// 只允许扫描根目录下的 .jsonl：挡住「随便传个路径让我覆盖」。
			// 只接受扫描根目录之下的 .jsonl。多项目布局下根是 sessions/，项目层是它的子目录，
			// 所以这里比的是**根**而不是某个具体项目目录 —— 否则第二个项目就写不了。
			if (!target.startsWith(resolve(SESSIONS_ROOT) + sep) || !target.endsWith(".jsonl")) {
				json(400, { ok: false, reason: "路径不在会话目录内" });
				return;
			}
			const { lines, entries } = await readSession(target);
			const before = measure(lines);
			// 聚合项（entry=-1、aggregate=true）：服务端自己重新判定该类**全部**条目。
			// 为什么不做成「界面传 12 万个下标」：那既超过请求体上限，又把判定复制到界面上 ——
			// 判定只能有一处（Ax5）。这里复用的是同一个 findAnomalies。
			const entriesIn = Array.isArray(body.entries) ? body.entries : [];
			const aggKinds = new Set(entriesIn.filter((a) => a.aggregate).map((a) => a.kind));
			const expanded = aggKinds.size
				? findAnomalies(entries).filter((a) => aggKinds.has(a.kind))
				: [];
			const chosen = [...expanded, ...entriesIn.filter((a) => !a.aggregate)]
				.map((a) => ({ entry: a.entry, block: a.block, kind: a.kind }));
			// 顺序：先折后删。两者都用**原始下标**，所以先做不改变行数的那一步。
			// 反过来（先删再折）会让折叠用到的 entry 下标整体错位——删掉第 5 行之后，
			// 原来的第 9 行变成第 8 行，而 chosen 里记的还是 9，折的就成了别的块。
			// 四步的顺序是判过的：接链与清签名都不改行数，折叠也不改行数，删除必须最后。
			// 反过来先删再接链，chosen 里的下标整体错位，接的就是别的条目。
			const rl = applyRelink(lines, entries, chosen);
			const cl = applyClean(rl.lines, entries, chosen);
			const fold = applyFold(cl.lines, entries, chosen, DEFAULTS);
			// 折叠改过内容，重新解析一遍给删除那一步用（行数与顺序都没变，下标仍然对齐）。
			const foldedEntries = fold.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
			// 按勾选执行，**不重新判断异常**：界面里人勾了 3 条却删了 50 条是不可接受的。
			// 只有两件结构必需的事会连带发生：级联删死引用、合并相邻 user（都会如实报数）。
			const rm = applyChosen(fold.lines, foldedEntries, chosen);
			const afterFold = rm.lines; // 四步之后：接链 → 清签名 → 折叠 → 删除
			const after = measure(afterFold);
			// editsRevoked 必传：context_edit 的 dup 规则删的正是「每个 target 唯一的那条复制品」，
			// 那是有意撤销（模型下一轮会看到完整 thinking），但必须可数、可对账。
			// 不传的话 verify 会按「一条都不许少」判，任何 dup 清理都被拒 —— 2026-11-26 实测。
			// cleanIds 必传：清签名要逐条核对「选中且仍存活的那些不再带签名」。
			// 不传的话 verify 只按数量判，遇到「条目同时被判为孤立思考、整条被删」就会误红。
			const cleanIds = chosen.filter((a) => CLEANABLE.includes(a.kind)).map((a) => entries[a.entry]?.id).filter((id) => typeof id === 'string');
			const v = verify(before, after, { relinked: rl.relinked, cleaned: cl.cleaned, cleanIds, usersMerged: rm.usersMerged, asstRemoved: rm.asstRemoved, editsRevoked: rm.editsRevoked, thinkRemoved: rm.thinkRemoved, foldsImages: true, maxImages: DEFAULTS.maxImages });
			if (!v.ok) {
				json(200, { ok: false, reason: "结构判据不通过，已拒绝写盘", checks: v.checks });
				return;
			}
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const { backup } = writeWithBackup(target, afterFold, join(BACKUP_ROOT, stamp));
			// 备份只写不删会无界增长（实测 131 份 / 6.1 GB）。每次写完顺带收一次：
			// 留最近 10 份、且不超过 7 天。清理失败不影响这次执行（备份是退路，不是主线）。
			let pruned = null;
			try { pruned = pruneBackups(BACKUP_ROOT, { keepRecent: 10, keepDays: 7 }); } catch { pruned = null; }
			json(200, {
				ok: true, removed: rm.removed, stripped: rm.stripped, rewired: rm.rewired, relinked: rl.relinked, relinkSkipped: rl.skipped, cleaned: cl.cleaned,
				cleaned: cl.cleaned, cleanSeen: cl.seen, cleanMissing: cl.missing,
				// folded 必报：折了 20 张图而返回里没有这个数，日志就会写「无变化」——
				// 那是关于一次真实改动的假话（2026-11-26 实测：折完 40→20 张，日志显示无变化）。
				folded: fold.folded,
				// 收了几个旧备份也报出来：不报的话「备份目录为什么变小了」没人说得清。
				backupsPruned: pruned ? pruned.removed.length : 0,
				sizeMB: +(statSync(target).size / 1048576).toFixed(1),
				backup: backup.replace(BACKUP_ROOT + sep, "…/").split(sep).slice(-2).join("/"),
				checks: v.checks,
			});
			return;
		}
		json(404, { ok: false, reason: "not found" });
	} catch (error) {
		json(500, { ok: false, reason: String(error && error.message ? error.message : error) });
	}
	});
}

/**
 * 起服务（可复用）：**端口固定 7788，不随机**（2026-11-25 用户原话：「不要随机，我本地使用，很安全」）。
 *
 * 「我可能会反复打开」用**单实例复用**解决，而不是换端口：
 *   1. 先探 7788 上的 /api/ping。是自己在跑就返回 { reused: true, port }，调用方
 *      只把窗口/浏览器指过去，不起第二个服务。
 *   2. 7788 被别的程序占着，抛 ALREADY_TAKEN，调用方如实报，不偷偷换端口。
 * 反例（2026-11-25 真机截图）：旧版直接抛 EADDRINUSE 整段栈，窗口停在
 * 「Press any key」，人只会以为工具坏了。
 */
export async function startServer({ port = PORT } = {}) {
	const running = await pingDoctor(port);
	if (running) return { reused: true, port, info: running, close: async () => undefined };
	const server = createDoctorServer();
	await new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolvePort(undefined);
		});
	}).catch((error) => {
		const wrapped = new Error(error?.code === "EADDRINUSE"
			? "端口 " + port + " 被别的程序占着（不是本工具）"
			: String(error?.message || error));
		wrapped.code = error?.code;
		throw wrapped;
	});
	return {
		reused: false,
		port: server.address().port,
		info: null,
		close: () => new Promise((r) => server.close(() => r(undefined))),
	};
}

/** 该端口上跑的是不是自己。超时 800ms，避免对着空端口等系统默认的几十秒。 */
export async function pingDoctor(port = PORT) {
	try {
		const r = await fetch("http://127.0.0.1:" + port + "/api/ping", { signal: AbortSignal.timeout(800) });
		if (!r.ok) return null;
		const info = await r.json();
		return info?.app === "session-doctor" ? info : null;
	} catch {
		return null;
	}
}

function openBrowser(link) {
	if (NO_OPEN) return;
	const cmd = process.platform === "win32" ? 'start "" "' + link + '"' : (process.platform === "darwin" ? 'open "' + link + '"' : 'xdg-open "' + link + '"');
	exec(cmd, () => undefined);
}

// ── CLI：只有直接跑这个文件时才执行；被桌面版 import 时不执行任何副作用 ──
// 路径换算必须用 fileURLToPath，不能用 new URL(...).pathname：
// 后者返回的是 URL 编码后的串，中文目录会被编成 %E4%BC%9A%E8%AF%9D…，
// 与 process.argv[1] 解出的真实路径永远不相等 —— 于是 invokedDirectly 恒假、
// 这个文件静默退出 rc=0、什么都不做，而且一个字节的报错都没有。
// 2026-11-26 实测：装到 C:/tmp/inst5/会话医生/... 后跑 node bin/session-doctor.mjs --no-open，
// rc=0，stdout/stderr 全空；同一份代码在纯 ASCII 路径下正常。产品名就是中文，所以这条必踩。
const invokedDirectly = (() => {
	try {
		if (!process.argv[1]) return false;
		return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	(async () => {
		const link = "http://127.0.0.1:" + PORT + "/";
		const started = await startServer({ port: PORT });
		if (started.reused && !args.includes("--new")) {
			console.log("已经在跑了（pid " + started.info.pid + "），直接打开界面。");
			console.log("界面 " + link);
			openBrowser(link);
			// 给浏览器一点时间接住这条命令再退出，否则 start 可能被一起收掉。
			await new Promise((r) => setTimeout(r, 400));
			process.exit(0);
		}
		console.log("界面 " + link);
		openBrowser(link);
		console.log("按 Ctrl+C 结束。");
		process.on("SIGINT", () => { void started.close(); process.exit(0); });
	})().catch((error) => {
		console.error("起服务失败：" + (error?.message || error));
		process.exit(error?.code === "EADDRINUSE" ? 1 : 1);
	});
}
