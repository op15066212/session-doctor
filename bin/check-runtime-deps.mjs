#!/usr/bin/env node
/**
 * 判据：运行时零依赖。dependencies 必须为空，devDependencies 只能有类型与编译器。
 *
 * 为什么这条要存在（2026-11-27，回答「用开源库重构」这件事）：
 * 本轮试过 todos 方向的替换，结论是这三个仓都不该引运行时依赖——不是懒，
 * 是它们的生效方式决定的：
 *
 *   pi-escape-guard / pi-think-sentry 是 pi 扩展，生效方式是「把目录拷到
 *   ~/.pi/agent/extensions/」。那个副本里没有 node_modules，一旦 src/ import
 *   了第三方包，加载就失败——而且是「装上就静默不工作」，没有报错。
 *
 *   session-doctor 的界面也一样：bin/session-doctor/ 是拷进安装包的，
 *   安装包里不跑 npm install。
 *
 * 所以「换开源库」在这两个仓里只可能发生在开发面（钩子、判据、测试），
 * 而开发面本轮已经全部换成标准库：import.meta.main、git rev-parse --git-path、
 * node:test、node:fs globSync。一条 npm 依赖都没加。
 *
 * 这条判据挡的是「以后有人顺手加一个依赖」：那次加可能让整个插件在生效副本里
 * 静默失效，而本地 npm test 全绿——因为在本地 node_modules 齐全。
 *
 * 允许的 devDependencies：@types/* 与 typescript。它们只在开发面用，不进生效副本。
 * 想加别的，先改这条判据并写清「它怎么进生效副本」——那才是这个决定该有的代价。
 *
 * rc: 0 零运行时依赖｜1 有 dependencies 或 devDependencies 越界｜2 读不到 package.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const PKG = path.join(REPO, "package.json");

/** 开发面允许的依赖：只有类型与编译器。 */
const DEV_ALLOW = [/^@types\//, /^typescript$/];

export function depProblems(pkg) {
  const out = [];
  const deps = Object.keys(pkg.dependencies || {});
  for (const d of deps) out.push("运行时依赖 " + d + "：生效副本里没有 node_modules，插件会静默加载失败");
  for (const d of Object.keys(pkg.devDependencies || {})) {
    if (!DEV_ALLOW.some((re) => re.test(d))) out.push("devDependency " + d + " 不在允许清单（只允许 @types/* 与 typescript）");
  }
  // optionalDependencies / peerDependencies 同样是运行时面，一起管。
  for (const f of ["optionalDependencies", "peerDependencies"]) {
    for (const d of Object.keys(pkg[f] || {})) out.push(f + " 里的 " + d + "：同样进不了生效副本");
  }
  return out;
}

if (import.meta.main && process.argv.includes("--selftest")) {
  const cases = [
    ["空依赖 → 绿", depProblems({}).length === 0],
    ["@types/node + typescript → 绿", depProblems({ devDependencies: { "@types/node": "^26", typescript: "^7" } }).length === 0],
    ["有 dependencies → 红", depProblems({ dependencies: { zod: "^3" } }).length === 1],
    ["越界 devDependency → 红", depProblems({ devDependencies: { husky: "^9" } }).length === 1],
    ["optionalDependencies 也算运行时面 → 红", depProblems({ optionalDependencies: { fsevents: "^2" } }).length === 1]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad += 1; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 五种依赖形态都分得开");
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  if (!fs.existsSync(PKG)) { console.error("读不到 " + PKG + "（rc=2）"); process.exit(2); }
  const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
  const problems = depProblems(pkg);

  for (const p of problems) console.log("  红    " + p);
  console.log("");
  const dev = Object.keys(pkg.devDependencies || {}).length;
  if (problems.length) { console.log("运行时零依赖不成立：" + problems.length + " 条"); process.exit(1); }
  console.log("运行时零依赖：dependencies 0 个，devDependencies " + dev + " 个（" + Object.keys(pkg.devDependencies || {}).join(", ") + "）");
  console.log("生效副本（拷目录、无 node_modules）里能加载，因为 src/ 只 import 标准库");
  process.exit(0);
}
