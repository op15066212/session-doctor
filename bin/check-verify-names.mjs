#!/usr/bin/env node
// 判据：verify() 报出的每一行判据，名字不许重复。
// 为什么要有（2026-11-26 实测）：同一个口径改过三次，旧的那份没删干净，
// 于是界面上「选中的条目清完不再带签名」出现两遍——一条用新口径、一条用旧口径。
// 两条同时红或同时绿时看不出来；一旦分叉，人会以为其中一条是另一条的重试。
// 判据取名字集合的大小做比较，不靠人眼看输出。
import { measure, verify } from "./lib/session-fix.mjs";

const T = "2026-11-26T01:00:00.000Z";
const msg = (id, parentId, content) => JSON.stringify({ type: "message", id, parentId, timestamp: T, message: { role: "assistant", content } });
const lines = [
  msg("m1", null, [{ type: "thinking", thinking: "思考", thinkingSignature: "sig" }, { type: "text", text: "正文" }]),
  msg("m2", "m1", [{ type: "text", text: "结束" }]),
];

let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };

// 用一次真实的 verify 调用取全部判据名：传空 expect 也行，名字表是静态的。
const before = measure(lines);
const v = verify(before, before, {});
const names = (v.checks || []).map((c) => c[0]);
const uniq = new Set(names);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
ok("verify 的判据名无重复", dup.length === 0, dup.length ? "重复：" + [...new Set(dup)].join(" / ") : names.length + " 条全不同");
ok("判据数不为 0（空表也能骗过上面那条）", names.length > 0, names.length + " 条");

// 坏样本：手工造一份带重复名字的表，证明比较方式真能判出来。
const fake = ["A", "A", "B"];
const fakeDup = fake.filter((n, i) => fake.indexOf(n) !== i);
ok("坏样本：重复名会被判出来", fakeDup.length > 0, "重复 " + fakeDup.length + " 条");

console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);