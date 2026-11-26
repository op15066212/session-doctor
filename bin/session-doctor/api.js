/**
 * 与后端通信的**唯一出口**。后端只有三个端点，都在 session-doctor.mjs 里：
 *
 *   GET  /api/ping   → { ok, app, dir, backup, pid }
 *   GET  /api/scan   → [{ path, name, project, sizeMB, entries, anomalies[], saveBytes }]
 *   POST /api/apply  → { ok, removed, stripped, usersMerged, folded, sizeMB, backup, checks[] }
 *
 * 为什么单独一个文件：fetch 散在界面各处时，「哪个请求在飞、失败怎么表示」就没人统一管，
 * 于是「点了没反应」和「请求挂了我没看见」长得一模一样。这里全部返回 { ok, data } / { ok, error }，
 * 调用方只判 ok，不碰 HTTP 细节。
 */

const BASE = "";

/** 统一超时：扫描 200MB 的会话要几秒，给 120 秒；再久就是真挂了。 */
const TIMEOUT_MS = 120000;

async function request(path, init) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {		const res = await fetch(BASE + path, { ...init, signal: controller.signal });		if (!res.ok) return { ok: false, error: "HTTP " + res.status };
		const data = await res.json();
		return { ok: true, data };
	} catch (error) {
		const msg = error?.name === "AbortError"
			? "请求超时（" + Math.round(TIMEOUT_MS / 1000) + " 秒）"
			: String(error?.message || error);
		// 空原因的失败最难查：日志里只剩一个「✕ 失败」和文件名，人不知道是网断了还是服务崩了。
		// 网络层异常的 message 在 Chromium 里可能是空串（尤其服务进程已退出时），必须给兜底文案。
		return { ok: false, error: msg || "网络请求失败（服务未响应，原因未知）" };
	} finally {
		clearTimeout(timer);
	}
}

export const api = {
	ping: () => request("/api/ping"),

	scan: () => request("/api/scan"),

	/** entries: [{ entry, entry 内块下标, kind }]；只传用户勾的那几条。 */
	apply: (path, entries) => request("/api/apply", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path, entries }),
	}),
};
