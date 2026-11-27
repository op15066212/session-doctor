#!/usr/bin/env node
/**
 * 判据：「跳过」本身要被判。
 *
 * 事故形状（2026-11-25 实测）：check-ui-e2e 缺 Electron 时 exit(0)，
 * 总闸把它显示成绿色——判据一天没真跑过，而报告说它绿。
 * 改成 rc=2 之后它可见了，但还差一步：**可见不等于有人补位**。
 * e2e 跳过的那天，界面层若一条判据都没跑，报告里是「跳过 1」，看着正常。
 *
 * 所以这条钉的是配对关系：
 *   check-ui-e2e 跳过（rc=2）  =>  check-ui-script 必须存在且 rc=0
 *   check-ui-e2e 真跑（rc=0/1）=>  配对关系不适用，本条直接绿
 *
 * 判据本身可证伪。坏样本（--selftest 真造输入）：
 *   ① 只有 e2e、没有 script（在临时目录里造）      -> 必须红 missing-fallback
 *   ② script 存在但 rc=1（写一个 exit(1) 的替身）  -> 必须红 uncovered
 *   ③ 现状：e2e 跳过、script 在跑                  -> 必须绿 covered
 *   ④ e2e 不跳过                                   -> 必须绿 not-skipped（配对不适用）
 *
 * 第一版 ①② 是假绿：judge 用模块级 HERE，于是「断言」说明的是「目录已建」，
 * 不是「判据在这个输入上会红」。所以改成 judge(dir, env) —— 判据必须能在别的目录上判，
 * 否则它自己的坏样本没地方放。（2026-11-27）
 *
 * 用法：node bin/check-skip-coverage.mjs [--selftest]
 * rc: 0 成立｜1 不成立｜2 环境缺失
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP_MARK = "跳过（rc=2 环境缺失）";

/** 跑一个判据，返回退出码。 */
function rcOf(file, env) {
	const r = spawnSync(process.execPath, [file], { env, encoding: "utf8", timeout: 180000 });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/**
 * 在一个目录上判配对关系。dir 里的文件名固定为 check-ui-e2e.mjs / check-ui-script.mjs。
 * 这样坏样本可以把两个文件复制到临时目录再改坏其中一个。
 */
export function judgeAt(dir, env = process.env) {
	const e2e = join(dir, "check-ui-e2e.mjs");
	const fb = join(dir, "check-ui-script.mjs");
	if (!existsSync(e2e)) return { ok: false, code: "missing-e2e", detail: "check-ui-e2e.mjs 不存在" };
	if (!existsSync(fb)) return { ok: false, code: "missing-fallback", detail: "check-ui-script.mjs 不存在——e2e 跳过时界面层无判据" };

	const e = rcOf(e2e, env);
	const skipped = e.out.includes(SKIP_MARK) || e.code === 2;
	if (!skipped) return { ok: true, code: "not-skipped", detail: `e2e 未跳过（rc=${e.code}），配对关系不适用` };

	const s = rcOf(fb, env);
	if (s.code === 0) return { ok: true, code: "covered", detail: "e2e 跳过，check-ui-script 在跑且绿（语法层兜底）" };
	return { ok: false, code: "uncovered", detail: `e2e 跳过且降级判据 rc=${s.code}——界面层此刻没有任何判据` };
}

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
	let bad = 0;
	const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (d ? "  [" + d + "]" : "")); if (!c) bad += 1; };
	const dir = mkdtempSync(join(tmpdir(), "skipcov-"));
	try {
		// ③ 现状：真目录上判 -> 必须绿 covered（本机无 Electron，走这条路）
		const r3 = judgeAt(HERE);
		ok("③ 现状：e2e 跳过时 script 在跑 -> 绿", r3.ok === true && ["covered", "not-skipped"].includes(r3.code), JSON.stringify(r3).slice(0, 110));

		// ① 只有 e2e、没有 script -> 必须红 missing-fallback
		const bare = join(dir, "bare");
		mkdirSync(bare, { recursive: true });
		copyFileSync(join(HERE, "check-ui-e2e.mjs"), join(bare, "check-ui-e2e.mjs"));
		const r1 = judgeAt(bare);
		ok("① 只有 e2e、没有 script -> 红 missing-fallback", r1.ok === false && r1.code === "missing-fallback", JSON.stringify(r1).slice(0, 110));

		// ② script 存在但 rc=1 -> 必须红 uncovered（先要 e2e 在这个目录里也跳过）
		const broken = join(dir, "broken");
		mkdirSync(broken, { recursive: true });
		copyFileSync(join(HERE, "check-ui-e2e.mjs"), join(broken, "check-ui-e2e.mjs"));
		writeFileSync(join(broken, "check-ui-script.mjs"), "process.exit(1);\n", "utf8");
		const r2 = judgeAt(broken);
		ok("② script rc=1 -> 红 uncovered", r2.ok === false && r2.code === "uncovered", JSON.stringify(r2).slice(0, 110));

		// ④ e2e 不跳过 -> 绿 not-skipped（用 exit(0) 的替身模拟「真跑过」）
		const live = join(dir, "live");
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, "check-ui-e2e.mjs"), "console.log(\"真跑 12 项全过\");\nprocess.exit(0);\n", "utf8");
		writeFileSync(join(live, "check-ui-script.mjs"), "process.exit(1);\n", "utf8");
		const r4 = judgeAt(live);
		ok("④ e2e 不跳过 -> 绿 not-skipped（配对不适用，不因 script 坏而红）", r4.ok === true && r4.code === "not-skipped", JSON.stringify(r4).slice(0, 110));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	console.log("");
	if (bad) { console.log("跳过配对：" + bad + " 条不符"); process.exit(1); }
	console.log("跳过配对：一处跳过必须有另一处在跑；缺位与坏掉都红，真跑时配对不干扰");
	process.exit(0);
}

const v = judgeAt(HERE);
if (v.ok) { console.log("  OK   " + v.detail); process.exit(0); }
console.error("  RED  " + v.detail);
process.exit(1);
