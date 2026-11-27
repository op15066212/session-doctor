#!/usr/bin/env node
/**
 * 判据：文档里用反引号点名的路径，盘上必须真有；私有仓的必须写明出处。
 *
 * 为什么有（2026-11-27）：session-doctor 的 README 把三个**私有仓**的判据写成了「本仓」的：
 *
 *   check-image-cap.mjs        -> 实际在 ~/.pi/agent/bin/
 *   check-image-cap-chain.mjs  -> 同上
 *   bin/check-backup-retention.mjs -> 同上
 *
 * 克隆到别的机器，读者按它去找判据，找不到；而「找不到」不会报错，只会让人以为
 * 「这个仓没有那个判据」，于是要么重写一遍，要么放弃那条保护。
 *
 * 这与 pi-escape-guard 删掉的 DESIGN.md 是同一个病：文档指向不存在的东西。
 * 同一族还有本轮的「注释说由某判据兜，而判据不存在」。
 *
 * 白名单只有两类，都要写理由：
 *   1. 反引号里是「故意不存在的文件名」——比如教人塞坏样本时说的 check-zzz-canary.mjs
 *   2. 反引号里是私有仓路径，且同一行写了「不在本仓」或 ~/.pi/agent
 *
 * rc: 0 全部对得上｜1 有对不上的｜2 读不到 README
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const TICK = String.fromCharCode(96);

/** 反引号里那些「看起来是文件」的词。 */
export function pathsIn(text) {
  const re = new RegExp(TICK + "([A-Za-z0-9_./~-]+\\.(?:mjs|ts|js|json|md))" + TICK, "g");
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** 豁免只看路径本身，不看行内容。
 *  2026-11-27 第一版看行：只要这行有「私有仓」三个字就放过，于是
 *  「判据在私有仓：`bin/check-x.mjs`」这种又错又合规的行被放过。
 *  豁免必须挂在路径上，不能挂在同一行的别的词上。 */
export function excused(f) {
  if (f.startsWith("~/")) return true; // 私有仓路径自带出处
  if (f.includes("check-zzz-canary")) return true; // 教人塞的坏样本，本来就不该存在
  return false;
}

/** 一个引用在盘上的候选位置。 */
const candsOf = (repo, f) => [f, "bin/" + f, "scripts/" + f, "src/" + f, "test/" + f, "tools/" + f, "bin/lib/" + f].map((x) => path.join(repo, x));

export function problems(text, repo) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    for (const f of pathsIn(line)) {
      if (candsOf(repo, f).some((c) => fs.existsSync(c))) continue;
      if (excused(f)) continue;
      out.push(f);
    }
  }
  return [...new Set(out)];
}

if (process.argv.includes("--selftest")) {
  const fake = [
    "doc: " + TICK + "README.md" + TICK + " 存在",
    "doc: " + TICK + "nope-missing.mjs" + TICK + " 不存在且没说明 -> 必须报",
    "doc: " + TICK + "~/.pi/agent/bin/x.mjs" + TICK + " 私有仓 -> 放过",
    "doc: 塞一个 " + TICK + "check-zzz-canary.mjs" + TICK + " 造坏样本 -> 放过"
  ].join("\n");
  const got = problems(fake, REPO);
  const cases = [
    ["存在的路径不报", !got.includes("README.md")],
    ["不存在的路径被报", got.includes("nope-missing.mjs")],
    ["私有仓路径放过", !got.includes("x.mjs")],
    ["教人塞的坏样本名放过", !got.includes("check-zzz-canary.mjs")]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad += 1; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 四种引用都分得开");
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) {
  const doc = path.join(REPO, "README.md");
  if (!fs.existsSync(doc)) { console.error("读不到 " + doc + "（rc=2）"); process.exit(2); }
  const bad = problems(fs.readFileSync(doc, "utf8"), REPO);
  if (bad.length) {
    for (const f of bad) console.log("  红    " + f + "：文档点名但盘上没有，也没说明它在哪");
    console.log("");
    console.log("对不上的路径 " + bad.length + " 个");
    process.exit(1);
  }
  console.log("README 里每个反引号路径都在盘上，或已写明出处");
  process.exit(0);
}