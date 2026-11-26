#!/usr/bin/env node
/**
 * 会话医生启动器（跨机器通用）。.cmd 只负责找到 node 然后调这里，逻辑全在这个文件。
 *
 * 为什么 .cmd 里不写中文：.cmd 按 OEM 代码页逐行解析，UTF-8 的中文在引号与括号附近
 * 会被切成命令的一部分（实测输出「'，最稳' is not recognized」）。Node 处理 UTF-8 没问题。
 *
 * 找 Electron 的顺序（先找到先用，全部相对本目录或环境，无绝对路径）：
 *   1. 环境变量 SESSION_DOCTOR_ELECTRON
 *   2. vendor/electron/electron.exe          ← 自带一份，最稳
 *   3. PATH 里的 electron
 *   4. node 能解析到的 electron 包           ← npm i -g electron 或本地装了
 *   5. 几个常见安装位置（PiDeck 开发仓、npm 全局根）
 * 找不到就降级成浏览器版：只要有 node 就能用，只是界面在浏览器标签页里。
 *
 * 参数原样透传（--port / --dir / --no-open 等都认）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startServer } from "../../bin/session-doctor.mjs";

const APP = dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.slice(2);

function isExe(p) {
	return typeof p === "string" && p.length > 3 && existsSync(p);
}

function findElectron() {
	const env = process.env.SESSION_DOCTOR_ELECTRON;
	if (isExe(env)) return env;

	for (const name of ["electron.exe", "electron"]) {
		const local = join(APP, "vendor", "electron", name);
		if (isExe(local)) return local;
	}

	// node 能解析到就最省事：electron 包导出的就是 exe 路径。
	try {
		const require = createRequire(join(APP, "launch.mjs"));
		const resolved = require("electron");
		if (isExe(resolved)) return resolved;
	} catch {
		// 没装就是没装，继续往下找
	}

	// npm 全局根：npm root -g 的输出不建议在这里 spawn，改成猜常见位置。
	const home = process.env.USERPROFILE || process.env.HOME || "";
	for (const p of [
		join(home, "AppData", "Roaming", "npm", "node_modules", "electron", "dist", "electron.exe"),
		join(home, "AppData", "Roaming", "npm", "node_modules", "electron", "dist", "electron"),
	]) {
		if (isExe(p)) return p;
	}
	return null;
}

function openBrowser(link) {
	const cmd = process.platform === "win32"
		? `start "" "${link}"`
		: process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
	spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref();
}

const electron = findElectron();
if (electron) {
	// --user-data-dir 指到应用自己目录：多份拷贝、换机器都不打架，也不污染别的 Electron 应用。
	const userData = join(APP, ".userdata");
	mkdirSync(userData, { recursive: true });
	const child = spawn(electron, [APP, "--user-data-dir=" + userData, ...passthrough], {
		stdio: "inherit",
		detached: false,
	});
	child.on("exit", (code) => process.exit(code ?? 0));
	child.on("error", (error) => {
		console.error("Electron 起不来：" + error.message);
		console.error("  " + electron);
		process.exit(1);
	});
} else {
	console.log("[提示] 没找到 Electron，用浏览器版启动。界面在浏览器标签页里，功能完全一样。");
	console.log("       想要独立窗口：npm i -g electron，或放一份到 vendor/electron/electron.exe");
	const port = Number(process.env.SESSION_DOCTOR_PORT || 7788);
	const started = await startServer({ port });
	const link = "http://127.0.0.1:" + started.port + "/";
	if (started.reused) {
		console.log("已经在跑了（pid " + started.info.pid + "），直接打开界面。");
		openBrowser(link);
		setTimeout(() => process.exit(0), 400);
	} else {
		console.log("界面 " + link);
		if (!passthrough.includes("--no-open")) openBrowser(link);
		console.log("按 Ctrl+C 结束。");
		process.on("SIGINT", async () => { await started.close(); process.exit(0); });
	}
}
