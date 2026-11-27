#!/usr/bin/env node
// @guards D10,D11   // 打包器断言只挡相对路径 / 真值路径假设失效
/**
 * 判据：本仓 bin/lib/session-fix.mjs 是**实体判定源**（不是转发），导出齐全；
 *       若本机私有仓 ~/.pi/agent/bin/lib/session-fix.mjs 存在，它必须是**一行转发**到本仓。
 *
 * 挡的两个事故（都是真发生过的）：
 *   1. 2026-11-26：两处各写一份判定逻辑，主仓修了 bug、本仓那份还是坏的，
 *      而所有判据读的都是本仓那份 —— 同一个输入，两个判决。
 *   2. 2026-11-27：本仓只有一行转发指向 ~/.pi/agent，克隆到别的机器
 *      import 立刻 ERR_MODULE_NOT_FOUND，十个判据里七个红。公开仓必须自足。
 *
 * 退出码：0 通过；1 形态不对或私仓写了第二份逻辑。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const TRUTH = join(REPO, "bin", "lib", "session-fix.mjs");
const PRIVATE = join(homedir(), ".pi", "agent", "bin", "lib", "session-fix.mjs");

function codeLines(src) {
	return src
		.split("\n")
		.filter((l) => {
			const t = l.trim();
			return t && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && t !== "*/";
		});
}

if (!existsSync(TRUTH)) {
	console.error("判定源不存在：" + TRUTH);
	process.exit(1);
}

const src = readFileSync(TRUTH, "utf8");
const lines = codeLines(src);
const isShim = lines.length <= 3 && /^export \* from ["'][^"']+["'];?$/.test(lines[0] || "");
if (isShim) {
	console.error("本仓的判定源是一行转发，不是实体：" + TRUTH);
	console.error("公开仓必须自带判定逻辑，否则克隆到任何机器都 import 断。");
	process.exit(1);
}
console.log("  OK   本仓是实体判定源（" + src.split("\n").length + " 行，" + (statSync(TRUTH).size / 1024).toFixed(1) + " KB）");

try {
	const m = await import(pathToFileURL(TRUTH).href);
	const need = ["readSession", "findAnomalies", "applyChosen", "measure", "verify"];
	const missing = need.filter((k) => typeof m[k] !== "function");
	if (missing.length) {
		console.error("导出缺失：" + missing.join(", "));
		process.exit(1);
	}
	console.log("  OK   导出齐全（" + need.length + " 个）");
} catch (err) {
	console.error("加载失败：" + (err && err.message ? err.message : err));
	process.exit(1);
}

if (!existsSync(PRIVATE)) {
	console.log("  --   本机没有私有仓那份（" + PRIVATE + "），跳过一致性判据");
	process.exit(0);
}
const psrc = readFileSync(PRIVATE, "utf8");
const plines = codeLines(psrc);
const pIsShim =
	plines.length <= 3 &&
	/^export \* from ["'][^"']*session-fix\.mjs["'];?$/.test(plines[0] || "");
if (!pIsShim) {
	console.error("私有仓那份有 " + plines.length + " 行代码，不是一行转发：" + PRIVATE);
	console.error("两处各写一遍判定逻辑 —— 改一处另一处还是旧的，会给出两个判决。");
	process.exit(1);
}
console.log("  OK   私有仓那份是一行转发，判定逻辑只有这一份");
process.exit(0);
