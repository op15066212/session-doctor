#!/usr/bin/env node
// 判据：把后端装到**中文目录**下，直接跑它必须真的起服务。
// 服务的真实事故（2026-11-26）：invokedDirectly 用 new URL(import.meta.url).pathname 取路径，
// 那是 URL 编码串（会话医生 → %E4%BC%9A%E8%AF%9D%E5%8C%BB%E7%94%9F），与 argv[1] 永远不相等。
// 结果：装到含中文的目录后，跑后端 rc=0、stdout 与 stderr 全空、什么都不做。
// 产品名就叫「会话医生」，所以这条必踩 —— 而纯 ASCII 路径下一切正常，本地测不出来。
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
// 目录名里必须带非 ASCII：这是本判据的整个要点。
const ROOT = join(tmpdir(), "session-doctor-cli-会话医生");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "bin"), { recursive: true });
mkdirSync(join(ROOT, "sessions"), { recursive: true });

// 只拷后端与判定逻辑，不拷前端（判的是 CLI 入口，不是界面）。
cpSync(join(REPO, "bin", "session-doctor.mjs"), join(ROOT, "bin", "session-doctor.mjs"));
mkdirSync(join(ROOT, "bin", "lib"), { recursive: true });
writeFileSync(join(ROOT, "bin", "lib", "session-fix.mjs"), readFileSync(join(REPO, "..", ".pi", "agent", "bin", "lib", "session-fix.mjs"), "utf8"));

let fail = 0;
const ok = (name, cond, detail = "") => { console.log((cond ? "OK   " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); if (!cond) fail += 1; };


const PORT = 7821;
const base = { SESSION_DOCTOR_DIR: join(ROOT, "sessions"), SESSION_DOCTOR_BACKUP: join(ROOT, "backups") };

// ① 服务必须真的起得来：进程还活着 + 端口接得住请求。
// 写成独立函数而不是 new Promise(async ...)：异步 executor 的异常会被吞掉，
// 判据自己失败时会静默挂住 —— 那正是这条判据要挡的形状。
const probe = () => {
  const child = spawn(process.execPath, [join(ROOT, "bin", "session-doctor.mjs"), "--port", String(PORT), "--no-open"], {
    env: { ...process.env, ...base }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let exited = null;
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (code) => { exited = code; });
  const waitAlive = () => {
    return new Promise((r) => setTimeout(r, 300));
  };
  const loop = async () => {
    let hit = false;
    for (let i = 0; i < 30 && exited === null; i += 1) {
      try {
        const res = await fetch("http://127.0.0.1:" + PORT + "/api/scan");
        if (res.ok) { hit = true; break; }
      } catch { /* 端口还没开 */ }
      await waitAlive();
    }
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    return { hit, exited, out, err };
  };
  return loop();
};
const live = await probe();
ok("中文目录下后端真的起服务", live.hit && live.exited === null, "接到=" + live.hit + " 提前退出=" + live.exited + " stderr=" + String(live.err).slice(0, 80));
ok("启动有话说（不是静默）", String(live.out).includes("界面"), JSON.stringify(String(live.out).slice(0, 60)));
// ② 坏样本：把修复撤掉（改回 URL.pathname），服务必须起不来。
// 这条是判据的判据：如果它不红，说明上面那条绿是因为别的原因绿的，不是因为修好了。
const BROKEN = "const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, \"$1\")); } catch { return false; } })();";
const GOOD = readFileSync(join(ROOT, "bin", "session-doctor.mjs"), "utf8");
const srcStart = GOOD.indexOf("// ── CLI：只有直接跑这个文件时才执行");
const srcEnd = GOOD.indexOf("if (invokedDirectly) {");
if (srcStart < 0 || srcEnd < 0) {
  ok("坏样本：能定位到入口判定段", false, "找不到这段注释或 if，判据失效");
} else {
  writeFileSync(join(ROOT, "bin", "session-doctor.mjs"), GOOD.slice(0, srcStart) + BROKEN + "\n\n" + GOOD.slice(srcEnd));
  const broken = await probe();
  ok("坏样本：撤掉修复后服务起不来", !broken.hit, "接到=" + broken.hit + " 提前退出=" + broken.exited);
  // 还原，避免后续步骤读到坏文件
  writeFileSync(join(ROOT, "bin", "session-doctor.mjs"), GOOD);
}
rmSync(ROOT, { recursive: true, force: true });
console.log(fail === 0 ? "RESULT=PASS" : "RESULT=FAIL " + fail);
process.exit(fail === 0 ? 0 : 1);