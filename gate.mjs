#!/usr/bin/env node
/**
 * 本仓总闸：跑 bin/ 下所有 check-*.mjs。
 *
 * 靠 glob 发现，不靠手工登记 —— 新写一条判据塞进 bin/ 就自动进执行面。
 *
 *   node gate.mjs           全部跑
 *   node gate.mjs --fast    跳过 check-ui-e2e（它要起真实 Electron，约 10 秒）
 *   node gate.mjs --list    只列判据
 *   node gate.mjs --selftest 造三个假判据（rc=0/1/2），验分类对不对
 *
 * 退出码：0 有绿且无红；1 有红；2 全部跳过（这台机器缺环境，不能报绿）。
 *
 * 2026-11-27 修的报告口径（组 2 指出）：判据的退出码早就分开了（环境缺失 2、失败 1），
 * 但报告把两者一起写成「红」，于是没装 Electron 的机器上永远是「9 绿 1 红」——
 * 人读到「红」，以为是代码坏。报告与退出码必须同一套口径。
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


/** 分类只看退出码：0 绿、1 红、2 及未知 跳过（环境缺失或对端没说清）。 */
export function classify(results) {
	const green = results.filter((r) => r.rc === 0);
	const red = results.filter((r) => r.rc === 1 || r.rc === null || r.rc === undefined);
	const skip = results.filter((r) => r.rc === 2 || (r.rc !== 0 && r.rc !== 1 && r.rc !== null && r.rc !== undefined));
	return { green, red, skip, rc: red.length ? 1 : green.length ? 0 : 2 };
}

if (argv.includes("--selftest")) {
	// 坏样本三条：任何一条分类错就 rc=1。
	const fake = [
		{ name: "check-ok.mjs", rc: 0 },
		{ name: "check-bad.mjs", rc: 1 },
		{ name: "check-env.mjs", rc: 2 }
	];
	const a = classify(fake);
	const cases = [
		["rc=0/1/2 各一条 → 绿 1 红 1 跳过 1", a.green.length === 1 && a.red.length === 1 && a.skip.length === 1],
		["有红时整体 rc=1", a.rc === 1],
		["只有绿 → rc=0", classify([{ rc: 0 }]).rc === 0],
		["全跳过 → rc=2（不能报绿）", classify([{ rc: 2 }, { rc: 2 }]).rc === 2],
		["进程崩了（rc=null）算红不算跳过", classify([{ rc: null }]).red.length === 1]
	];
	let bad = 0;
	for (const [name, ok] of cases) {
		console.log((ok ? "PASS  " : "FAIL  ") + name);
		if (!ok) bad += 1;
	}
	console.log("selftest: " + (bad ? bad + " 条不符" : "分类口径对得上"));
	process.exit(bad ? 1 : 0);
}

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
		results.push({ name: f, rc: 2, skipped: true });
		console.log("skip  " + f);
		continue;
	}
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [join(BIN, f)], { stdio: "pipe", encoding: "utf8" });
	const secs = ((Date.now() - t0) / 1000).toFixed(1);
	const rc = r.status;
	results.push({ name: f, rc });
	const mark = rc === 0 ? "ok   " : rc === 2 ? "env? " : "RED  ";
	console.log(mark + f + "  " + secs + "s");
	if (rc !== 0) {
		const out = (r.stdout || "") + (r.stderr || "");
		console.log(out.split("\n").slice(0, 25).map((l) => "      " + l).join("\n"));
	}
}

const { green, red, skip, rc } = classify(results);
console.log("");
console.log(results.length + " 条判据：绿 " + green.length + " / 红 " + red.length + " / 跳过 " + skip.length + "（环境缺失）");
if (red.length) console.log("红：" + red.map((r) => r.name).join(", "));
if (skip.length) console.log("跳过：" + skip.map((r) => r.name).join(", ") + " —— 没验：缺环境（要 Electron）或缺活数据快照。不代表代码坏，但也不算绿");
process.exit(rc);
