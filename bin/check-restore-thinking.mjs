#!/usr/bin/env node
// 判据：从备份回填 thinking 块，且**只补块、不动链**。
// 服务的真实事故（2026-11-26）：摘块函数不看 kind，把 17 个会话共 22024 个 thinking 块整块摘掉，
// 而当时判据只数签名字段，写盘一路绿灯。恢复能力必须有判据，否则它自己也会伤到链。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TOOL = join(HERE, "restore-thinking.mjs");
const ROOT = join(tmpdir(), "session-doctor-restore");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "sessions"), { recursive: true });
mkdirSync(join(ROOT, "backups"), { recursive: true });

const ID = "2026-01-01T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
const T = "2026-11-26T01:00:00.000Z";
const msg = (id, parentId, content) => JSON.stringify({ type: "message", id, parentId, timestamp: T, message: { role: "assistant", content } });

// 备份（来源）：两条消息都带 thinking（其中一条还带签名）
const bak = [
  msg("m1", null, [{ type: "thinking", thinking: "第一段思考", thinkingSignature: "sig-1" }, { type: "text", text: "第一段正文" }]),
  msg("m2", "m1", [{ type: "text", text: "第二段正文" }, { type: "thinking", thinking: "第二段思考" }]),
].join("\n") + "\n";
writeFileSync(join(ROOT, "backups", "2026-11-26T05-00-00-000Z_" + ID), bak);

// 现文件（骨架）：thinking 块被摘光了，其它块与备份逐字节相同
const cur = [
  msg("m1", null, [{ type: "text", text: "第一段正文" }]),
  msg("m2", "m1", [{ type: "text", text: "第二段正文" }]),
].join("\n") + "\n";
const curPath = join(ROOT, "sessions", ID);
writeFileSync(curPath, cur);

let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };

const run = (extra) => {
  try {
    return { rc: 0, out: execFileSync(process.execPath, [TOOL, "--dir", join(ROOT, "sessions"), "--backup", join(ROOT, "backups"), ...extra], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
};

const dry = run([]);
ok("dry-run 不写盘", readFileSync(curPath, "utf8") === cur, "rc=" + dry.rc);
ok("dry-run 报出可补条数", /可补 thinking 2/.test(dry.out), dry.out.trim().split("\n").pop());

const w = run(["--write"]);
ok("写盘 rc=0", w.rc === 0, "rc=" + w.rc);
const after = readFileSync(curPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const th = after.reduce((n, e) => n + e.message.content.filter((b) => b.type === "thinking").length, 0);
ok("thinking 块补回 2 个", th === 2, "补回 " + th);
ok("行数不变", after.length === 2, String(after.length));
ok("id 与 parentId 逐条不变", after[0].id === "m1" && after[0].parentId === null && after[1].id === "m2" && after[1].parentId === "m1");
ok("精确插回原位（m1 的 thinking 在 text 前）", after[0].message.content[0].type === "thinking" && after[0].message.content[1].text === "第一段正文", after[0].message.content.map((b) => b.type).join(","));
ok("m2 的 thinking 在 text 后", after[1].message.content[1].type === "thinking", after[1].message.content.map((b) => b.type).join(","));
const sigs = after.reduce((n, e) => n + e.message.content.filter((b) => b.thinkingSignature).length, 0);
ok("不把 thinkingSignature 带回来", sigs === 0, "带回 " + sigs + " 个");
ok("正文逐字不变", after[0].message.content[0].thinking === "第一段思考" && after[0].message.content[1].text === "第一段正文");

// 坏样本：备份里没有这个会话 → 一条都不许补（更不能凭空造块）
const OTHER = "2026-01-01T00-00-00-000Z_ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl";
writeFileSync(join(ROOT, "sessions", OTHER), cur);
const noBak = run(["--write"]);
const otherAfter = readFileSync(join(ROOT, "sessions", OTHER), "utf8");
ok("坏样本 无备份时一条不补", otherAfter === cur, "rc=" + noBak.rc);

// 坏样本：目录不存在 → 不许崩（rc 2 记环境缺失，不是通过）
const missing = (() => {
  try { execFileSync(process.execPath, [TOOL, "--dir", join(ROOT, "没有这个目录"), "--backup", join(ROOT, "backups")], { encoding: "utf8" }); return 0; }
  catch (e) { return e.status ?? 1; }
})();
ok("坏样本 目录不存在时安静退出", missing === 0, "rc=" + missing);

rmSync(ROOT, { recursive: true, force: true });
console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);