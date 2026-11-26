# 会话医生 · 桌面版

扫描本机所有 pi 会话，列出异常（空壳消息、重复快照、悬空编辑、超长块、重复图片），
勾选后一键清理。判定与执行全部走 `../../bin/lib/session-fix.mjs` —— 与命令行版
`prune-session.mjs` / `fold-session.mjs` 同一套规则，一处可写。

## 双击哪个

| 文件 | 用途 |
|---|---|
| `launch.cmd` | **双击这个**。自动找 Electron 起独立窗口；找不到就用浏览器打开（功能一样） |
| `launch.mjs` | 真正的启动逻辑（.cmd 只负责找到 node） |
| `main.mjs` | Electron 主进程：一个窗口 + 单实例锁 |
| `setup-electron.mjs` | 把本机已有的 Electron 接到 `vendor/electron`（目录联接，不占空间） |
| `icon.png` / `icon.ico` | 图标 |

## 换一台机器 / 换盘 / 换用户名

**路径全部从环境推导，没有一个绝对路径。**

```
会话根        ~/.pi/agent/sessions          （pi 自己定的位置，下面每个项目一个子目录）
备份根        ~/.pi/agent/.session-backups
```

换机器只要三步：

```bash
# 1. 装 Node（已装跳过）
# 2. 装 Electron，或者把已有的指过来
npm i -g electron
#    或者： node setup-electron.mjs --from <某个 electron 的 dist 目录>
#    或者： 把 electron 直接解压到 vendor/electron/
# 3. 双击 launch.cmd
```

没有 Electron 也能用：`launch.cmd` 会降级成浏览器版，只要 Node 在。

要指到别的位置（多个盘的会话、别人机器上的目录）：

```bash
launch.cmd --dir "D:/somewhere/sessions" --backup "E:/backups"
# 或环境变量
set SESSION_DOCTOR_DIR=D:/somewhere/sessions
set SESSION_DOCTOR_PORT=7788
set SESSION_DOCTOR_ELECTRON=C:/some/electron/electron.exe
```

## 反复打开为什么不会出问题

用户原话：「我可能会反复打开」。三层保证，实测 10 次连点进程数不变：

| 层 | 做法 | 落空会怎样 |
|---|---|---|
| Electron 单实例锁 | `app.requestSingleInstanceLock()`；第二次起只把已有窗口叫到前面并刷新 | 每点一次多一份 400MB 的进程 |
| 端口复用 | 起服务前先探 `/api/ping`；是自己在跑就复用，不起第二个服务 | 撞 `EADDRINUSE`，旧版直接抛整段栈、窗口停在 Press any key |
| 固定端口 | 7788 不随机；被**别的程序**占着就如实报并给 `--port`，不偷偷换 | 换端口后书签/快捷方式失效，而且用户不知道换了 |

`--user-data-dir` 指到本目录的 `.userdata/`：多份拷贝、换机器都不打架，也不污染别的 Electron 应用。

## 界面

左边文件列表（按大小排，带项目标签），右边异常清单。清单是**虚拟滚动**：固定行高 30px，
只渲染可见的十几行 + 12 行缓冲，上万条也不卡（13 万条 context_edit 的会话曾把 DOM 卡死过）。

底部三个勾选按钮（全部可删 / 全部可折 / 全不选），右下「执行」。执行前弹确认，写明将改几个
文件、删几条、折几块、省多少；执行时每个文件整份备份到 `.session-backups/<时间戳>/`，
结构判据不通过就拒绝写盘并列出哪一条没过。

## 判据

```bash
node ../../bin/check-ui-script.mjs          # 界面脚本语法 + $("id") 都真在 DOM 里
node ../../bin/check-ui-script.mjs --selftest  # 3 条坏样本
```

第一条是真出过的事：脚本里混进真实换行 → 整个 `<script>` 语法错 → 界面永远「正在读取…」，
而 HTML 渲染完全正常，从截图看不出是 JS 的问题。
