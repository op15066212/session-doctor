/**
 * 纯格式化与字典。无 DOM、无状态、无请求 —— 谁都能 import，谁都不会被它带副作用。
 */
import { ALL } from "./store.js";
export { KINDS, metaOf, actionOf } from "./kinds.js";

// 类型表在 kinds.js（store 也要用）。这里只做 re-export，避免两处各写一份。

// 小于 1 MB 用 KB：23K 的可省量印成「0.0 MB」等于告诉人「没有可省的」（2026-11-25 截图里
// 三张卡片写着 8K、8K、7K，顶栏却是 0.0 MB，同一件事两处两个数）。
export const fmtMB = (b) => (b < 1048576 ? Math.max(0, Math.round((b || 0) / 1024)) + " KB" : (b / 1048576).toFixed(1) + " MB");
export const fmtBytes = (b) => (b > 1024 ? Math.round(b / 1024) + "K" : String(b || 0));
export const riskEsc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const esc = riskEsc;
export const shortName = (n, n2 = 30) => String(n).replace(/\.jsonl$/, "").slice(0, n2);
export const shortProject = (p) => {
	const t = String(p || "").replace(/^--/, "").replace(/--$/, "");
	const seg = t.split("-").filter(Boolean);
	return seg.length > 2 ? "…" + seg.slice(-2).join("-") : t;
};
export const fmtClock = (d = new Date()) => {
	const p = (n) => String(n).padStart(2, "0");
	return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
};
export { ALL };
