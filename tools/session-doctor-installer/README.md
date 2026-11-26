# 会话医生 · 安装包

把会话医生打成 Windows 上的一个 `exe`，双击装到任意目录，装完是普通桌面程序。
产物放桌面上：`会话医生-安装.exe`。

## 重打

```bash
cd ~/.pi/agent
node tools/session-doctor-installer/build-installer.mjs            # 完整打包
node tools/session-doctor-installer/build-installer.mjs --layout   # 只生成布局，不打 7z
```

需要：7-Zip（默认 `C:\Program Files\7-Zip\7z.exe`，可用 `SEVENZIP` 覆盖）、
一份 Electron 运行时（自动从三个位置找，可用 `SESSION_DOCTOR_ELECTRON_DIST` 指向它的 dist 目录）。

## 包是怎么拼出来的

```
会话医生/
  electron.exe 等运行时         ← 从本机已有的 Electron 复制（locales 只留 zh-CN / en-US / zh-TW）
  resources/app/
    main.mjs                   ← 复制自 ../session-doctor-desktop/main.mjs，只改一行 import
    bin/session-doctor.mjs     ← 后端（与 CLI 同一份）
    bin/lib/session-fix.mjs    ← 判定唯一源
    bin/session-doctor/        ← 前端（index.html + 7 个模块 + css + vendor）
```

Electron 默认加载 `resources/app`，所以运行 `electron.exe` 就等于运行这个程序。

**一个真值源**：所有文件从仓库复制，不在这里重写第二份。唯一被改的是 `main.mjs` 的
`import` 路径（`../../bin/…` → `./bin/…`），改完脚本立刻断言改到了，否则退出 1。

## 为什么不用 electron-builder

这台机器上装不上：npm 12 报 `EALLOWREMOTE`，拒绝从 `https://registry.npmmirror.com/ws/-/ws-8.22.2.tgz`
拉包（某个依赖把 tarball 地址写死了）。7-Zip 的 SFX 是等价物，产物同样是 exe，
而且不依赖网络、不依赖 node。

代价：SFX 是不带卸载项的绿色安装（解压即用），没有「控制面板里卸载」。
要卸载就删掉那个目录。

## 验过什么

| 项 | 怎么验 | 结果 |
| --- | --- | --- |
| 布局能独立跑 | 从 `app/` 里 `node bin/session-doctor.mjs --port 7797`，curl ping 与 scan | 返回 `{ok:true}`，扫描 20 个文件 |
| 安装包能解压 | `7z x stage/app.7z` | 解出 47 个文件、316 MiB |
| 解压后 electron 真能起 | 目录里跑 `electron.exe .`，杀掉旧服务后 curl `/api/ping` | 返回新 pid 的 `{ok:true}` |
| 安装包体积 | — | 92 MB（压缩自 316 MB） |

## 装完之后

扫码范围仍是 `~/.pi/agent/sessions`，备份仍写 `~/.pi/agent/.session-backups`——
与 CLI 版完全同源。换机器、换盘、换用户名都跟着环境走，包内没有写死路径。
