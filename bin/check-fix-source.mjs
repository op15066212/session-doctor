#!/usr/bin/env node
/**
 * 判据：本仓的 bin/lib/session-fix.mjs 能解析到真值，且真值确实在盘上。
 *
 * 挡的事故：转发路径层数数错（bin/lib/ 到 home 是三层，不是四层），
 * import 落到 C:\Users\.pi\agent\... 这种不存在的路径 —— 界面一启动就
 * ERR_MODULE_NOT_FOUND，而语法检查、模块检查全都还是绿的。
 *
 * 退出码：0 解析成功；1 解析失败；2 真值源不存在（环境缺失）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SHIM = join(REPO, "bin", "lib", "session-fix.mjs");
const TRUTH = join(REPO, "..", ".pi", "agent", "bin", "lib", "session-fix.mjs");

if (!existsSync(TRUTH)) {
	console.error("真值源不存在：" + TRUTH);
	console.error("（这台机器上没有 ~/.pi/agent，转发无解）");
	process.exit(2);
}
if (!existsSync(SHIM)) {
	console.error("转发文件不存在：" + SHIM);
	process.exit(1);
}

// 形态判据：这个文件必须只有转发，不许有第二份判定逻辑（2026-11-26：两处各写一遍，
// 我在主仓修了 bug，本仓那份还是坏的，而所有判据读的都是本仓这份）。
const src = readFileSync(SHIM, "utf8");
const code = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"));
const isReexport = code.length === 1 && /^export \* from "[..\/]+\.pi\/agent\/bin\/lib\/session-fix\.mjs";$/.test(code[0].trim());
if (!isReexport) {
	console.error("转发文件里有 " + code.length + " 行代码，不是一行转发：" + SHIM);
	console.error("本仓不许有第二份判定逻辑 —— 主仓改了这里不改，两边会给出两个判决。");
	process.exit(1);
}
console.log("  OK   形态：一行转发，本仓无第二份判定逻辑");

try {
	const m = await import(pathToFileURL(SHIM).href);
	const need = ["readSession", "findAnomalies", "applyChosen", "measure", "verify"];
	const missing = need.filter((k) => typeof m[k] !== "function");
	if (missing.length) {
		console.error("转发解析成功，但缺导出：" + missing.join(", "));
		process.exit(1);
	}
	console.log("  OK   转发 → 真值，导出齐全（" + need.length + " 个）");
	process.exit(0);
} catch (err) {
	console.error("转发解析失败：" + (err && err.message ? err.message : err));
	console.error("转发文件内容：");
	console.error("  " + join(SHIM));
	process.exit(1);
}
