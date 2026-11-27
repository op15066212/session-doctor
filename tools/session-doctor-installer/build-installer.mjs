#!/usr/bin/env node
/**
 * build-installer.mjs —— 把会话医生打成 Windows 安装包（NSIS），产物放桌面。
 *
 * 为什么要打包而不是「双击 launch.cmd」：后者要求本机有 Node，换台机器就废。
 * 安装包把 Electron 运行时、后端、前端一起封进去，装完是一个普通桌面程序。
 *
 * 布局（打包前后**同一套相对路径**，这样 main.mjs 里的 import 不用改）：
 *   app/
 *     package.json          { main: "main.mjs" }
 *     main.mjs              复制自 ../session-doctor-desktop/main.mjs
 *     icon.png / icon.ico
 *     bin/session-doctor.mjs
 *     bin/lib/session-fix.mjs
 *     bin/session-doctor/**  （前端：index.html + 7 个 js + css + vendor）
 *
 * 一个真值源：文件一律从仓库里**复制**，不在这里重写第二份。
 * 反例（这条挡的）：把 main.mjs 抄进来再改路径 —— 两份 handler 就是两份口径。
 *
 * 用法：
 *   node tools/session-doctor-installer/build-installer.mjs            # 生成布局并打包
 *   node tools/session-doctor-installer/build-installer.mjs --layout   # 只生成布局（不装依赖不打包）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.resolve(HERE, "..", "..");          // ~/.pi/agent
const APP = path.join(HERE, "app");
const LAYOUT_ONLY = process.argv.includes("--layout");

// 备份/临时文件不进产物。为什么不能只靠事后断言：本机出现过「删不掉就原地覆盖」
// （EPERM 时 rmSync 被跳过），于是上一轮留下的 .bak 一直在 APP 里，断言每轮都红、
// 而红的原因不是源码脏了。排除在前（保证产物干净），断言在后（挡住别的路径）。
const JUNK = /\.(bak|orig|tmp|log|rej)$|~$/;
const cp = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !JUNK.test(src) });
};

// ── 1 布局 ──────────────────────────────────────────
// 为什么不是无条件 rmSync：本机实测 EPERM / EBUSY（有进程 cwd 停在这个目录里，
// 或杀软正在扫）。删不掉就打包失败，等于把一次可恢复的占用变成阻塞。
// 改成「能删就删，删不掉就原地覆盖」——cp 用的是 cpSync(force)，逐文件覆盖。
// 原地覆盖有个副作用：上一轮的残留不会被删。2026-11-26 实测：两个 *.bak 因此
// 一直躺在 APP 里，下面的断言每轮都红，而红的原因根本不是源码脏了。
// 所以站起来前先按扩展名清一遍（只清 junk，不动产物本该有的文件）。
const sweepJunk = (dir) => {
  let n = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { n += sweepJunk(p); continue; }
    if (JUNK.test(d.name)) { try { fs.rmSync(p, { force: true }); n += 1; } catch { /* 占用：留给断言报 */ } }
  }
  return n;
};
try { fs.rmSync(APP, { recursive: true, force: true }); } catch { const swept = sweepJunk(APP); if (swept) console.log("  占用中：清掉 " + swept + " 个残留备份"); }
fs.mkdirSync(APP, { recursive: true });

cp(path.join(ROOT, "tools", "session-doctor-desktop", "main.mjs"), path.join(APP, "main.mjs"));
cp(path.join(ROOT, "tools", "session-doctor-desktop", "icon.png"), path.join(APP, "icon.png"));
cp(path.join(ROOT, "tools", "session-doctor-desktop", "icon.ico"), path.join(APP, "icon.ico"));
cp(path.join(ROOT, "bin", "session-doctor.mjs"), path.join(APP, "bin", "session-doctor.mjs"));
// 判定逻辑的真值在主仓（本仓 bin/lib/session-fix.mjs 只是一行转发）。
// 安装包要装到别的机器上，必须带实体文件，所以从真值源直接取。
// 真值在主仓。原写法「从 ROOT 的父目录推」只在构建器住在 ~/.pi/agent/tools/ 下时成立；
// 仓搬到 ~/projects/session-doctor 之后，推出 ~/projects/.pi/agent/bin/lib/session-fix.mjs，
// 打包直接 rc=2（2026-11-27 实测）。改成候选表，取第一个「存在且不是转发」的：
// 转发文件只有一行，真值 800+ 字节。
const FIX_CANDIDATES = [
  process.env.SESSION_FIX_SRC,
  path.resolve(ROOT, "..", ".pi", "agent", "bin", "lib", "session-fix.mjs"),
  path.join(os.homedir(), ".pi", "agent", "bin", "lib", "session-fix.mjs"),
  path.join(ROOT, "bin", "lib", "session-fix.mjs"),
].filter(Boolean);
const SESSION_FIX_SRC = FIX_CANDIDATES.find((f) => {
  try { return fs.statSync(f).size > 200; } catch { return false; }
});
if (!SESSION_FIX_SRC) {
  console.error("打包失败：候选里没有实体判定逻辑（都小于 200 字节或是转发）：");
  for (const f of FIX_CANDIDATES) console.error("  " + f);
  process.exit(2);
}
cp(SESSION_FIX_SRC, path.join(APP, "bin", "lib", "session-fix.mjs"));
// 断言：复制进来的是实体，不是转发。转发文件装到别的机器上 import 就断。
{
  const packed = fs.readFileSync(path.join(APP, "bin", "lib", "session-fix.mjs"), "utf8");
  if (/export \* from "(\.\.\/){2,}/.test(packed)) {
    console.error("打包失败：session-fix.mjs 是指向别处的转发，安装包里会断");
    process.exit(1);
  }
}
cp(path.join(ROOT, "bin", "session-doctor"), path.join(APP, "bin", "session-doctor"));

// 产物里不许有编辑器/脚本留下的备份。为什么这条要在这里：
// 2026-11-26 实测 —— 两个 *.bak 被一起拷进 app/，于是安装包里躺着
// components.js.bak / store.js.bak（14490 字节的旧版本，没人会打开，但它进了交付物）。
// 判据从产物反推：扫 APP 目录，命中就拒绝打包。
{
  const junk = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      if (/\.(bak|orig|tmp|log|rej)$/.test(d.name) || d.name.endsWith("~")) junk.push(path.relative(APP, p));
    }
  };
  walk(APP);
  if (junk.length) {
    console.error("打包失败：产物里有备份/临时文件 " + junk.join(", "));
    process.exit(1);
  }
}

// main.mjs 的 import 是 "../../bin/session-doctor.mjs"（相对 tools/session-doctor-desktop/）。
// 打包后它在 app/ 根，于是改成 "./bin/session-doctor.mjs"。这是**唯一**必须改的一行，
// 改完立刻断言，避免「以为改了其实没改」。
const mainPath = path.join(APP, "main.mjs");
let mainSrc = fs.readFileSync(mainPath, "utf8");
const before = mainSrc;
mainSrc = mainSrc.replace('from "../../bin/session-doctor.mjs"', 'from "./bin/session-doctor.mjs"');
if (mainSrc === before) {
  console.error("打包布局失败：main.mjs 里的 import 路径没匹配上（源码改过了？）");
  process.exit(1);
}
fs.writeFileSync(mainPath, mainSrc);

fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({
  name: "session-doctor",
  productName: "会话医生",
  version: "1.0.0",
  private: true,
  description: "扫描本机 pi 会话，出示异常，勾选清理，每次写盘前整份备份",
  type: "module",
  main: "main.mjs",
  author: "session-doctor",
  build: {
    appId: "local.session-doctor",
    productName: "会话医生",
    // asar 关掉：后端用 fs 读前端静态文件（UI_DIR），解压目录少一层不确定性。
    asar: false,
    directories: { output: path.join(HERE, "dist") },
    files: ["main.mjs", "icon.png", "icon.ico", "bin/**/*"],
    win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "icon.ico" },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "会话医生",
    },
  },
}, null, 2) + "\n");

// 自己数文件：不调外部命令（那会在 Windows 上扫到盘根，实测撞权限错误）。
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log("布局完成：" + APP + "（" + count(APP) + " 个文件）");

// ── 2 安装包：electron 运行时 + our app → 7z 自解压 exe ────────────────
// 为什么不用 electron-builder：npm 12 在这台机器上拒绝 remote tarball（EALLOWREMOTE，
// 某个依赖把 ws 的地址写成了 npmmirror URL），装不上。7-Zip 的 SFX 是等价物：
// 双击 → 选目录 → 解压 → 运行，产物同样是一个 exe，且不依赖网络与 node。
//
// 目录形状（Electron 的默认查找规则）：
//   会话医生/
//     electron.exe 等运行时
//     resources/app/  ← main.mjs + bin/（我们的东西）
//   直接运行 electron.exe 就会加载 resources/app。
if (LAYOUT_ONLY) process.exit(0);

const STAGE = path.join(HERE, "stage");
const PAYLOAD = path.join(STAGE, "会话医生");
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(PAYLOAD, { recursive: true });

// electron 运行时：从环境变量或三个已知位置里找（不写死用户名路径）
const electronDist = (() => {
  const env = process.env.SESSION_DOCTOR_ELECTRON_DIST;
  if (env && fs.existsSync(env)) return env;
  const home = os.homedir();
  const cands = [
    path.join(ROOT, "tools", "session-doctor-desktop", "vendor", "electron"),
    path.join(home, "src", "PiDeck", "v099", "node_modules", "electron", "dist"),
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "electron", "dist"),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, "electron.exe"))) return c;
  return null;
})();
if (!electronDist) {
  console.error("找不到 electron 运行时。设 SESSION_DOCTOR_ELECTRON_DIST 指向它的 dist 目录。");
  process.exit(2);
}
console.log("electron 运行时：" + electronDist);
// locales 只留中文与英文：整套 locales 有 50+ 个 .pak，删掉不影响功能，体积少一半。
for (const name of fs.readdirSync(electronDist)) {
  if (name === "locales") continue;
  cp(path.join(electronDist, name), path.join(PAYLOAD, name));
}
fs.mkdirSync(path.join(PAYLOAD, "locales"), { recursive: true });
for (const f of fs.readdirSync(path.join(electronDist, "locales"))) {
  if (!/^(zh-CN|en-US|zh-TW)\.pak$/.test(f)) continue;
  cp(path.join(electronDist, "locales", f), path.join(PAYLOAD, "locales", f));
}
// resources 里只留我们自己的 app（原来那个 default_app.asar 用不上）
fs.rmSync(path.join(PAYLOAD, "resources"), { recursive: true, force: true });
cp(APP, path.join(PAYLOAD, "resources", "app"));

// 7z 打包 + sfx
const SEVENZ = process.env.SEVENZIP || "C:\\Program Files\\7-Zip\\7z.exe";
if (!fs.existsSync(SEVENZ)) { console.error("找不到 7z：" + SEVENZ); process.exit(2); }
const SFX = path.join(path.dirname(SEVENZ), "7z.sfx");
const archive = path.join(STAGE, "app.7z");
execFileSync(SEVENZ, ["a", "-t7z", "-mx=5", archive, path.join(STAGE, "会话医生")], { stdio: "inherit" });

// sfx 配置：标题、解压目录、完成后询问是否运行
fs.writeFileSync(path.join(STAGE, "config.txt"), [
  ";!@Install@!UTF-8!",
  "Title=\"会话医生\"",
  "BeginPrompt=\"要把会话医生装到哪里？\"",
  "ExtractTitle=\"正在安装会话医生…\"",
  "RunProgram=\"%%T\\会话医生\\electron.exe\"",
  ";!@InstallEnd@!",
  "",
].join("\n"), "utf8");

const out = path.join(os.homedir(), "Desktop", "会话医生-安装.exe");
const combined = path.join(STAGE, "combined.exe");
fs.writeFileSync(combined, Buffer.concat([
  fs.readFileSync(SFX),
  fs.readFileSync(path.join(STAGE, "config.txt")),
  fs.readFileSync(archive),
]));
fs.copyFileSync(combined, out);
console.log("安装包：" + out + "  （" + (fs.statSync(out).size / 1048576).toFixed(0) + " MB）");
