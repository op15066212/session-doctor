#!/usr/bin/env node
// 判据：执行结果的**每一个动作都要有数**，一个都不许沉默。
// 事故（2026-11-26）：折了 20 张超限图片、链上 40 → 20，返回里没有 folded 字段，
// 界面上那行写「完成 … 无变化」—— 那是关于一次真实改动的假话。
// 判的是「返回对象的键」而不是某次具体输出：漏字段与「这次没折」在输出上长得一样。
import { applyFold, applyClean, applyRelink, applyChosen, KIND, DEFAULTS, CLEANABLE, RELINKABLE } from "./lib/session-fix.mjs";

let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };

const T = "2026-11-26T01:00:00.000Z";
const lines = [JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: T, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(40000) }] } })];
const entries = lines.map((l) => JSON.parse(l));

// ① 折叠必须报 folded
const fold = applyFold(lines, entries, [{ entry: 0, block: 0, kind: KIND.BIG_TEXT }], DEFAULTS);
ok("applyFold 报 folded", typeof fold.folded === "number" && fold.folded === 1, "folded=" + fold.folded);

// ② 清签名报 cleaned / seen / missing
const sigLines = [JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: T, message: { role: "assistant", content: [{ type: "thinking", thinking: "思考", thinkingSignature: "s" }] } })];
const cl = applyClean(sigLines, sigLines.map((l) => JSON.parse(l)), [{ entry: 0, block: 0, kind: KIND.THINKING_SIGNATURE }]);
ok("applyClean 报 cleaned/seen/missing", cl.cleaned === 1 && cl.seen === 1 && cl.missing === 0, JSON.stringify({ cleaned: cl.cleaned, seen: cl.seen, missing: cl.missing }));

// ③ 接链报 relinked / skipped
const broken = [JSON.stringify({ type: "message", id: "m1", parentId: "gone", timestamp: T, message: { role: "user", content: [{ type: "text", text: "x" }] } })];
const rl = applyRelink(broken, broken.map((l) => JSON.parse(l)), [{ entry: 0, block: null, kind: KIND.BROKEN_LINK }]);
ok("applyRelink 报 relinked/skipped", typeof rl.relinked === "number" && typeof rl.skipped === "number", JSON.stringify({ relinked: rl.relinked, skipped: rl.skipped }));

// ④ 删除报 removed / thinkRemoved（thinkRemoved 进了判据，漏传会让合法删除被判红）
const rm = applyChosen([], [], []);
ok("applyChosen 空跑也报全套字段", ["removed", "stripped", "rewired", "asstRemoved", "usersMerged", "cascadedEdits", "editsRevoked", "thinkRemoved"].every((k) => typeof rm[k] === "number"), Object.keys(rm).join(","));

// ⑤ 服务端返回必须带上这些数：读源码，断言五个字段都被返回
const src = (await import("node:fs")).readFileSync(new URL("./session-doctor.mjs", import.meta.url), "utf8");
const need = ["removed", "stripped", "folded", "cleaned", "relinked", "thinkRemoved"];
const missing = need.filter((k) => !src.includes(k + ":"));
ok("/api/apply 返回带全部计数", missing.length === 0, missing.length ? "漏：" + missing.join(",") : need.length + " 个都在");

console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);