#!/usr/bin/env node
/**
 * 判据：一个异常类要么有坏样本，要么被点名记在基线里。基线只能缩小。
 *
 * 为什么有（2026-11-27）：组 2 提议把 bin/lib/session-fix.mjs（1155 行）拆成三层，
 * 条件是「拆完 17 类异常的坏样本逐条红」。我先把这句话变成可查的东西，结论是：
 * 17 类里 13 类没有任何坏样本，4 类只在 check-ui-e2e.mjs（要 Electron）里被提到。
 * 也就是说「拆完样本逐条红」这个验收条件当场不成立——样本还不存在。
 * 先补样本，再谈拆分。
 *
 * 判据形状与理由：
 *   kind 出现在任何 bin/check-*.mjs 或 test/ 文件里 = 有样本
 *   没有样本但在 BASELINE 里 = 允许（基线写理由）
 *   没有样本且不在 BASELINE 里 = rc=1（新增一类异常却没给样本）
 *   BASELINE 里的类现在有了样本 = 提示一句，rc 仍 0
 *     （这一条不红，因为「要求人删基线」会变成噪音；但提示会一直在，直到人删）
 *
 * rc: 0 通过｜1 有新增异常类缺样本｜2 读不到判定源
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SRC = path.join(REPO, "bin", "lib", "session-fix.mjs");

if (!fs.existsSync(SRC)) { console.error("读不到判定源：" + SRC); process.exit(2); }

/** 判定源里 KIND 的全部取值（字符串字面量，按值比较，不按常量名）。 */
export function kindsIn(src) {
  const block = src.match(/export const KIND = \{([\s\S]*?)\n\};/);
  if (!block) return [];
  const out = [];
  for (const m of block[1].matchAll(/^\s*[A-Z_]+:\s*"([^"]+)"/gm)) out.push(m[1]);
  return out;
}

/** 定义在 KIND 里、却从没被 findAnomalies 产生过的常量。
 *
 *  为什么单独一条判据（2026-11-27 实测发现）：unreachable 只有定义行，
 *  文件里 KIND.UNREACHABLE 出现 0 次——而在 measure() 里另有一个同名的统计量
 *  unreachable（自己算可达性），两者无关。于是这个「异常类」永远不会产生。
 *
 *  后果比缺样本更糟：覆盖率判据会把它永远放在「缺样本」里，人看到的是
 *  「这一类还没写坏样本」，而真相是「这一类不存在」。一个恒缺的项会
 *  长期霸占待办，并把真正的缺口比例冲淡。
 *
 *  这就是 README 里记过的那种形状：stats 计数声明了没自增。
 *  声明的计数不自增，比不声明更坏——人以为在看数据。
 */
export function deadKinds(src) {
  const names = [...src.matchAll(/^\s*([A-Z_]+):\s*"/gm)].map((m) => m[1]);
  return names.filter((n) => (src.split("KIND." + n).length - 1) === 0);
}

/** 在磁盘上「有样本」= 这个 kind 的字符串出现在某个 check-*.mjs 或 test/ 文件里。 */
export function coveredBy(kind, files) {
  return files.filter((f) => f.text.includes(kind)).map((f) => f.path);
}


/**
 * 布尔格上的莫比乌斯反演：
 * cumulative[A] = Σ(B⊇A) exact[B]，反演后 exact 恢复每个精确覆盖组合。
 * 只做 n≤4：全枚举成本是 2^n，超过上限必须先缩小候选集。
 */
export function subsetZeta(exact, n) {
  if (!Number.isInteger(n) || n < 0 || n > 4 || exact.length !== 2 ** n) throw new Error("n 必须在 0..4 且数组长度为 2^n");
  const out = [...exact];
  for (let bit = 0; bit < n; bit++) {
    for (let mask = 0; mask < out.length; mask++) {
      if ((mask & (1 << bit)) === 0) out[mask] += out[mask | (1 << bit)];
    }
  }
  return out;
}

export function subsetMobiusInvert(cumulative, n) {
  if (!Number.isInteger(n) || n < 0 || n > 4 || cumulative.length !== 2 ** n) throw new Error("n 必须在 0..4 且数组长度为 2^n");
  const out = [...cumulative];
  for (let bit = 0; bit < n; bit++) {
    for (let mask = 0; mask < out.length; mask++) {
      if ((mask & (1 << bit)) === 0) out[mask] -= out[mask | (1 << bit)];
    }
  }
  return out;
}

/** 把「一个探针覆盖哪些异常类」的累积数反演成精确组合数。 */
export function coverageProfile(kinds, files, limit = 4) {
  const chosen = kinds.slice(0, limit);
  const n = chosen.length;
  const cumulative = Array(2 ** n).fill(0);
  for (const file of files) {
    let mask = 0;
    for (let i = 0; i < n; i++) if (file.text.includes(chosen[i])) mask |= 1 << i;
    for (let need = 0; need < cumulative.length; need++) if ((mask & need) === need) cumulative[need]++;
  }
  return { chosen, cumulative, exact: subsetMobiusInvert(cumulative, n) };
}

function loadProbes() {
  const out = [];
  const binDir = path.join(REPO, "bin");
  for (const f of fs.readdirSync(binDir)) {
    if (/^check-.*\.mjs$/.test(f) && f !== "check-anomaly-coverage.mjs") {
      out.push({ path: "bin/" + f, text: fs.readFileSync(path.join(binDir, f), "utf8") });
    }
  }
  const testDir = path.join(REPO, "test");
  if (fs.existsSync(testDir)) {
    for (const f of fs.readdirSync(testDir)) {
      if (/\.(mjs|js|ts)$/.test(f)) out.push({ path: "test/" + f, text: fs.readFileSync(path.join(testDir, f), "utf8") });
    }
  }
  return out;
}

if (process.argv.includes("--selftest")) {
  const src = fs.readFileSync(SRC, "utf8");
  const kinds = kindsIn(src);
  const fake = [{ path: "bin/check-x.mjs", text: "坏样本：" + kinds[0] }];
  const cases = [
    ["坏实现一：只做 ζ 累积，未反演", (() => {
      const exact = [1, 2, 0, 3];
      return JSON.stringify(subsetZeta(exact, 2)) !== JSON.stringify(exact);
    })()],
    ["坏实现二：把 μ 的减法写成加法", (() => {
      const exact = [1, 2, 0, 3];
      const z = subsetZeta(exact, 2);
      const wrong = [...z];
      for (let bit = 0; bit < 2; bit++) for (let mask = 0; mask < wrong.length; mask++)
        if ((mask & (1 << bit)) === 0) wrong[mask] += wrong[mask | (1 << bit)];
      return JSON.stringify(wrong) !== JSON.stringify(exact);
    })()],
    ["坏实现三：把数论 μ 套进布尔格", (() => {
      const exact = [1, 2, 0, 3];
      const z = subsetZeta(exact, 2);
      const wrong = z.map((v, mask) => v * (mask === 0 ? 1 : mask === 3 ? 0 : -1));
      return JSON.stringify(wrong) !== JSON.stringify(exact);
    })()],
    ["布尔格 ζ/μ 互逆 n=1..4", [1,2,3,4].every((n) => {
      const exact = Array.from({ length: 2 ** n }, (_, i) => (i * 3 + 1) % 5);
      return JSON.stringify(subsetMobiusInvert(subsetZeta(exact, n), n)) === JSON.stringify(exact);
    })],
    ["错格：n=4 的数据不能用 n=3 吞掉", (() => {
      try { subsetMobiusInvert([1,2,3], 3); return false; } catch { return true; }
    })()],
    ["重复覆盖 3→1：反演能恢复恰好覆盖", (() => {
      const files = [{ text: "a b" }, { text: "a b" }, { text: "a" }];
      const p = coverageProfile(["a", "b"], files);
      return p.exact[3] === 2 && p.exact[1] === 1;
    })()],
    ["从判定源读出全部异常类（>= 10）", kinds.length >= 10],
    ["有样本的类能被认出", coveredBy(kinds[0], fake).length === 1],
    ["没样本的类认不出（用一个不存在的 kind）", coveredBy("zzz-not-a-kind", fake).length === 0],
    ["死常量能认出：定义一个从没被 KIND.x 引用的常量 → 必须报", deadKinds('const KIND = {\n  ZZZ_DEAD: "zzz-dead",\n};').length === 1],
    ["真被引用的常量不报", deadKinds('const KIND = {\n  ZZZ_DEAD: "zzz-dead",\n};\nout.push(KIND.ZZZ_DEAD);').length === 0]
  ];
  let bad = 0;
  for (const [n, ok] of cases) { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) bad++; }
  console.log(bad ? "selftest: " + bad + " 条不符" : "selftest: 抽取与比对都成立");
  process.exit(bad ? 1 : 0);
}

const srcText = fs.readFileSync(SRC, "utf8");
const kinds = kindsIn(srcText);
const dead = deadKinds(srcText);
if (!kinds.length) { console.error("读不出 KIND 全表（rc=2）"); process.exit(2); }
const probes = loadProbes();

// 基线：已知缺样本的类。写理由，且只能缩小——补了样本就从这里删掉。
//
// 2026-11-27 清空：16 类全部有真样本（各有正样本与反例，见 bin/check-anomaly-samples.mjs）。
// 空表不是「这条判据没事可做」，而是它当前的最强结论：没有任何一类缺样本。
// 留着这个结构，是为了让「新增一类异常」时必须显式登记或立刻补样本——
// 否则 rc=1。把结构删掉，就退化成「谁都可以加类、谁都不用给样本」。
const BASELINE = new Map(Object.entries({}));

let missing = 0;
if (dead.length) {
  for (const n of dead) console.log("  红    " + n + " 定义在 KIND 里，但文件里 KIND." + n + " 出现 0 次——这个类从没被产生过");
  missing += dead.length;
}
let stale = 0;
for (const k of kinds) {
  const hit = coveredBy(k, probes);
  if (hit.length) {
    continue;
  }
  console.log("  红    " + k + " 没有任何坏样本，也不在基线里");
  missing++;
}

// 弱覆盖：只在 check-ui-e2e.mjs 里出现。那条要 Electron，本机一直跳过——
// 「提到了」不等于「验过了」。2026-11-27 实测：thinking-only 与 big-text 正是这种形状，
// 它们在覆盖率里一直算「有样本」，而这条判据从没在本机跑红过。
const WEAK = "bin/check-ui-e2e.mjs";
const weak = kinds.filter((k) => {
  const hits = coveredBy(k, probes);
  return hits.length > 0 && hits.every((h) => h === WEAK);
});
if (weak.length) console.log("  弱覆盖（只在要 Electron 的 e2e 里提到，本机跳过）：" + weak.join(", "));
const profile = coverageProfile(kinds, probes);
const nonzero = profile.exact
  .map((count, mask) => ({ mask, count }))
  .filter((x) => x.count > 0);
const label = (mask) => {
  const names = profile.chosen.filter((_k, i) => (mask & (1 << i)) !== 0);
  return names.length ? names.join(" + ") : "无候选覆盖";
};
console.log("布尔格反演（候选 n=" + profile.chosen.length + "，μ(S)=(-1)^|S|）：");
for (const x of nonzero) console.log("  恰好 " + label(x.mask) + "：" + x.count);
const uncovered = kinds.filter((k) => !coveredBy(k, probes).length);
console.log("");
console.log("异常类共 " + kinds.length + " 类：有样本 " + (kinds.length - uncovered.length - weak.length) + " / 弱覆盖 " + weak.length + " / 缺样本 " + uncovered.length);
if (stale) console.log("基线里 " + stale + " 类已被覆盖，可从 BASELINE 删掉");
if (missing) { console.log("新增 " + missing + " 类缺样本（基线只能缩小，不能新增）"); process.exit(1); }
process.exit(0);