#!/usr/bin/env node
/**
 * 本仓总闸：跑 bin/ 下所有 check-*.mjs。
 *
 * 靠 glob 发现，不靠手工登记 —— 新写一条判据塞进 bin/ 就自动进执行面。
 *
 *   node gate.mjs           全部跑
 *   node gate.mjs --fast    跳过 check-ui-e2e（它要起真实 Electron，约 10 秒）
 *   node gate.mjs --list    只列判据
 *
 * 退出码：0 全绿；1 有红；2 环境缺失（找不到 node 之外的东西，如 electron）。
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "bin");
const argv = process.argv.slice(2);
const fast = argv.includes("--fast");
const listOnly = argv.includes("--list");

const SLOW = new Set(["check-ui-e2e.mjs"]);

const checks = readdirSync(BIN)
	.filter((f) => /^check-.*\.mjs$/.test(f))
	.sort();

if (listOnly) {
	for (const f of checks) console.log((SLOW.has(f) ? "[慢] " : "     ") + "bin/" + f);
	process.exit(0);
}

const results = [];
for (const f of checks) {
	if (fast && SLOW.has(f)) {
		results.push({ name: f, rc: 0, skipped: true });
		console.log("skip  " + f);
		continue;
	}
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [join(BIN, f)], { stdio: "pipe", encoding: "utf8" });
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	const rc = r.status ?? 1;
	results.push({ name: f, rc });
	const mark = rc === 0 ? "ok   " : rc === 2 ? "env? " : "RED  ";
	console.log(mark + f + "  " + secs + "s");
	if (rc !== 0) {
		const out = (r.stdout || "") + (r.stderr || "");
		console.log(out.split("\n").slice(0, 25).map((l) => "      " + l).join("\n"));
	}
}

const red = results.filter((r) => r.rc !== 0);
const env = red.filter((r) => r.rc === 2);
console.log("");
console.log(results.length + " 条判据，" + (results.length - red.length) + " 绿，" + red.length + " 红");
if (red.length) {
	console.log("红：" + red.map((r) => r.name).join(", "));
	process.exit(env.length === red.length ? 2 : 1);
}
process.exit(0);
