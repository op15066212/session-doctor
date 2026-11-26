/**
 * 会话医生 · 桌面版主进程。
 *
 * 它与 CLI 的关系：服务端只有一份 —— bin/session-doctor.mjs 的 createDoctorServer / startServer。
 * 这个文件只做「开一个窗口，把窗口指向那个服务」，一行判定逻辑都没有。
 * 两份 handler 就是两份口径，迟早一个改了另一个没改（今天已经在界面与两个 CLI 之间发生过一次）。
 *
 * 反复打开（用户原话：「我可能会反复打开」）有两层保证：
 *   1. **单实例锁**：Electron 的 requestSingleInstanceLock。第二次双击不会起第二个进程，
 *      只会让已有窗口浮到前面并刷新。这一层连 Electron 进程都不多开。
 *   2. **端口复用**：如果 7788 已经被 CLI 版占着，startServer 返回 reused，直接连过去。
 *      不报错、不换端口、不起第二个服务。
 *
 * 反例（2026-11-25 真机截图）：旧版 CLII 反复启动时抛 EADDRINUSE 整段栈，窗口停在
 * 「Press any key」，人以为工具坏了。这里的两层就是挡这个。
 */
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { join } from "node:path";
import { startServer } from "../../bin/session-doctor.mjs";

const PORT = 7788;
let win = null;
let server = null;
let quitting = false;

// 单实例锁必须在 app ready 之前拿。拿不到就说明已有实例在跑，直接退出 —— 
// 已有实例会收到 second-instance 事件，由它把窗口浮上来。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		// 用户又双击了一次：把窗口叫到前面并刷新（可能是改过界面想看一眼）。
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
		win.webContents.reload();
	});

	app.on("window-all-closed", () => { quitting = true; app.quit(); });

	app.whenReady().then(async () => {
		try {
			server = await startServer({ port: PORT });
		} catch (error) {
			dialog.showErrorBox("会话医生起不来", String(error?.message || error) + "\n\n换个端口：给桌面快捷方式加参数 --port 7790，或用命令行版。");
			app.quit();
			return;
		}
		createWindow();
	});

	// 退出时把服务关掉。CLI 起的那个（reused）不归我们关 —— close 是空操作。
	app.on("before-quit", async (event) => {
		if (!server || server.reused || quitting) return;
		quitting = true;
		event.preventDefault();
		await server.close();
		app.quit();
	});
}

function createWindow() {
	win = new BrowserWindow({
		width: 1480,
		height: 920,
		minWidth: 900,
		minHeight: 560,
		title: "会话医生 · Session Doctor",
		backgroundColor: "#ffffff",
		icon: join(import.meta.dirname, "icon.png"),
		autoHideMenuBar: true,
		// 不用 titleBarStyle: hidden —— Windows 上自绘标题栏要自己处理拖动/最大化/贴边，
		// 这一件事不值得。保留系统标题栏，观感与普通桌面程序一致。
		webPreferences: {
			// 界面是纯静态页 + 同源 fetch，不需要 Node、不需要 preload。
			// 关掉就等于把「界面能碰文件系统」这条攻击面整个删掉。
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	Menu.setApplicationMenu(null);
	win.loadURL("http://127.0.0.1:" + (server?.port ?? PORT) + "/");
	// 外链一律交给系统浏览器：窗口里不该长出第二个浏览器。
	win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
	win.on("closed", () => { win = null; });
}
