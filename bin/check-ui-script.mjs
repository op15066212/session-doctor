#!/usr/bin/env node
/**
 * 前端模块判据：bin/session-doctor 下**每个模块**都能被 node 解析。
 *
 * 为什么还要这条（e2e 已经覆盖更多）：e2e 需要 Electron，换台没装的机器就整体跳过。
 * 那时界面就完全没有判据了。这条只要有 node 就能跑，抓的是「语法坏 / import 路径坏」，
 * 与 e2e 的分工是「最便宜的兜底」对「最贵的真跑」。
 *
 * 为什么用 node --check 而不是 vm.Script：模块里的 export/import 在 Script 上下文里是语法错，
 * 会给出成片的假红。--check 按 .js 的 package type 判断，所以 bin/session-doctor/package.json
 * 里那句 "type": "module" 是这条判据能成立的前提。
 *
 * 反例（都真发生过）：脚本里混进真实换行 → 整个模块语法错 → 界面永远「正在读取」；
 * import "./vendor/preact.mjs" 写成 "./preact.mjs" → 404 → 模块图崩。
 */
import { readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "session-doctor");
/** 口径上限：只扫这两个目录、不递归 vendor（vendor 是上游文件，逐个验没有意义）。 */
const MAX_FILES = 200;

function collect(dir, out, depth = 0) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (name === "vendor") continue;
			if (depth < 2) collect(full, out, depth + 1);
			continue;
		}
		if (/\.(m?js)$/.test(name) && out.length < MAX_FILES) out.push(full);
	}
}

function checkOne(file) {
	const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	return r.status === 0 ? null : (r.stderr || "").split("\n").slice(0, 3).join(" ").trim();
}

const files = [];
try { collect(UI, files); } catch (e) {
	console.log("读不到前端目录：" + UI + "（" + e.message + "）");
	process.exit(1);
}
if (!files.length) {
	console.log("前端目录里没有模块：有什么东西坏了");
	process.exit(1);
}

let bad = 0;
for (const f of files) {
	const err = checkOne(f);
	if (err) { bad += 1; console.log("  FAIL " + relative(HERE, f) + "  " + err.slice(0, 160)); }
}
console.log("  " + (bad ? "" : "OK   ") + files.length + " 个模块" + (bad ? "，" + bad + " 个语法错" : "全过"));

// 顺带验一句：入口必须存在，否则 e2e 与浏览器都会白屏。
const entry = join(UI, "index.html");
try {
	statSync(entry);
} catch {
	console.log("  FAIL 缺 index.html（挂载点）");
	bad += 1;
}

// --selftest：造一个语法坏的模块，判据必须红。
if (process.argv.includes("--selftest")) {
	const tmp = join(UI, "_selftest_broken.js");
	writeFileSync(tmp, 'const a = "第一行\n第二行";\n');
	const err = checkOne(tmp);
	rmSync(tmp, { force: true });
	const ok = Boolean(err);
	console.log("  " + (ok ? "PASS" : "FAIL") + "  坏样本" + (ok ? "被判红" : "没被发现"));
	process.exit(ok ? 0 : 1);
}

console.log(bad ? "前端模块判据 " + bad + " 处红" : "前端模块判据 全过");
process.exit(bad ? 1 : 0);
