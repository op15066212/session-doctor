#!/usr/bin/env node
/**
 * 把本机已有的 Electron 接到 vendor/electron（目录联接，不占额外空间）。
 *
 * 为什么要有这一步：Electron 二进制约 200MB，复制一份进仓库不现实；
 * 而把某个绝对路径写死进启动器，换机器就断。所以拆成两件事：
 *   - launch.mjs 只认 vendor/electron（完全通用）
 *   - 这个脚本负责「把这台机器上已有的 Electron 指过去」（一次性，换机器再跑一次）
 *
 * 用法：
 *   node setup-electron.mjs                 自动找
 *   node setup-electron.mjs --from <dist目录或electron.exe>
 *   node setup-electron.mjs --check         只看找到没，不动盘
 *
 * 幂等：vendor/electron 已存在就跳过，不重复建。
 */
import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const APP = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(APP, "vendor");
const LINK = join(VENDOR, "electron");
const EXE = process.platform === "win32" ? "electron.exe" : "electron";
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const fromArg = args[args.indexOf("--from") + 1];

/** 从「exe 路径」或「dist 目录」都接受，统一返回 dist 目录。 */
function asDist(p) {
	if (!p) return null;
	const abs = resolve(String(p).replace(/^"|"$/g, ""));
	if (existsSync(join(abs, EXE))) return abs;
	if (existsSync(abs) && abs.endsWith(EXE)) return dirname(abs);
	return null;
}

function candidates() {
	const out = [];
	if (fromArg) out.push(fromArg);
	// 1. 当前 node 能解析的 electron 包
	try {
		const require = createRequire(join(APP, "setup-electron.mjs"));
		out.push(require("electron"));
	} catch { /* 没装就往下 */ }
	// 2. npm 全局根（问 npm 自己，不猜前缀）
	const npm = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" });
	if (npm.status === 0) out.push(join(npm.stdout.trim(), "electron", "dist"));
	// 3. 用户目录下的常见位置
	for (const p of [
		join(homedir(), "AppData", "Roaming", "npm", "node_modules", "electron", "dist"),
		join(homedir(), ".npm-global", "lib", "node_modules", "electron", "dist"),
		"/usr/local/lib/node_modules/electron/dist",
		"/usr/lib/node_modules/electron/dist",
	]) out.push(p);
	return out;
}

const found = candidates().map(asDist).find(Boolean);
if (!found) {
	console.error("没找到 Electron。装一个：npm i -g electron");
	console.error("或用 --from 指到已有的 dist 目录（里面有 " + EXE + "）。");
	process.exit(1);
}
console.log("找到 Electron：" + found);

if (checkOnly) process.exit(0);

if (existsSync(LINK)) {
	console.log("vendor/electron 已存在，跳过（要重建先删掉它）。");
	process.exit(0);
}

mkdirSync(VENDOR, { recursive: true });
try {
	// Windows 上用目录联接（junction）：不需要管理员权限、不占空间；
	// 其它平台用相对符号链接。
	if (process.platform === "win32") {
		const r = spawnSync("cmd", ["/c", "mklink", "/J", LINK, found], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stdout || r.stderr || "mklink 失败");
	} else {
		symlinkSync(found, LINK, "dir");
	}
	console.log("已接到 vendor/electron → " + found);
} catch (error) {
	// 建链接失败就退而求其次：直接用环境变量指过去，并告诉用户。
	console.error("建链接失败：" + (error?.message || error));
	console.error("改用环境变量：set SESSION_DOCTOR_ELECTRON=" + join(found, EXE));
	try { rmSync(LINK, { force: true }); } catch { /* 清不掉就算了 */ }
	process.exit(1);
}
if (!existsSync(join(LINK, EXE))) {
	console.error("链接建好了但 " + EXE + " 不在里面，检查一下：" + LINK);
	process.exit(1);
}
console.log("就绪：launch.cmd 现在会起独立窗口。");
