# 会话医生

扫出 pi 会话里的图片异常（重名、零字节、重复内容），勾选后修掉。
三种入口：桌面安装包、命令行起网页、Electron 桌面壳。数据全读 `~/.pi/agent/sessions`。

## 立刻用

桌面上双击 `会话医生-安装.exe`，选个目录装完就是普通程序。

不想装，直接跑：

```bash
node bin/session-doctor.mjs              # 起本地网页并自动打开浏览器
node bin/session-doctor.mjs --no-open    # 只起服务
node bin/session-doctor.mjs --port 7799  # 指定端口
```

Electron 桌面壳（需要本机有 Electron）：

```bash
node tools/session-doctor-desktop/setup-electron.mjs   # 找一份 Electron 进来
node tools/session-doctor-desktop/launch.mjs
```

## 目录

```
bin/
  session-doctor.mjs      后端：HTTP + 扫描 + 执行（约 700 行，无依赖）
  session-doctor/         前端：preact + htm + TanStack virtual-core，纯 ESM 无构建
    index.html  app.js  components.js  store.js  api.js  format.js  kinds.js  app.css
    vendor/               前端依赖（preact/htm/virtual-core），直接进仓
    e2e-probe.cjs         E2E 探针
  lib/session-fix.mjs     ← 一行转发，见下
  check-ui-script.mjs     判据：前端每个模块都能被 node 解析
  check-ui-e2e.mjs        判据：真起 Electron，跑一遍打开→扫描→勾选
  check-fix-source.mjs    判据：转发路径能解析到真值
tools/
  session-doctor-desktop/ Electron 壳（main.mjs 只做窗口 + 起后端）
  session-doctor-installer/ 打包脚本：Electron 运行时 + app/ → 7z SFX → exe
gate.mjs                  总闸：glob 发现 bin/check-*.mjs 全跑
```

## 判定逻辑不在本仓

`bin/lib/session-fix.mjs` 只有一行 `export * from`，真值在
`~/.pi/agent/bin/lib/session-fix.mjs`。

原因：那个文件的消费者是本机五个入口——`prune-session`、`fold-session`、
会话医生界面、`check-session-fix-verify`、`check-context-edit`。复制一份进本仓，
就要在两处分别维护「什么算异常」，迟早给出两个不同判决。所以本仓只做转发。

**路径层数**：`bin/lib/` 到 home 是三层（`../../../`）。数错一层会 import 到
`C:\Users\.pi\...`，界面一启动就 `ERR_MODULE_NOT_FOUND`，而语法检查全绿。
`check-fix-source.mjs` 就是挡这个的。

**副作用**：本仓不是自包含的。clone 到没有 `~/.pi/agent` 的机器上，界面起不来。
安装包不受影响——打包时从真值源复制实体文件，包里是完整的。

## 打包

```bash
node tools/session-doctor-installer/build-installer.mjs            # 完整打包
node tools/session-doctor-installer/build-installer.mjs --layout   # 只生成布局
```

需要 7-Zip（`C:\Program Files\7-Zip\7z.exe`，可用 `SEVENZIP` 覆盖）和一份 Electron
运行时（自动找，可用 `SESSION_DOCTOR_ELECTRON_DIST` 指定 dist 目录）。
产物：`~/Desktop/会话医生-安装.exe`（约 92 MB）。

没用 electron-builder：本机 npm 12 报 `EALLOWREMOTE`，拒绝从 npmmirror 的
tarball 地址拉包。7z SFX 是等价物，产物同样是 exe，不依赖网络。代价是绿色版——
没有「控制面板卸载」，删目录即卸载。

## 判据

```bash
node gate.mjs            # 全跑
node gate.mjs --fast     # 跳过 check-ui-e2e（要真起 Electron，约 10 秒）
node gate.mjs --list     # 只列
```

退出码：0 全绿，1 有红，2 环境缺失（如没有 Electron）。

## 和 ~/.pi/agent 的关系

以前这些文件散在 `~/.pi/agent/bin/` 和 `~/.pi/agent/tools/` 里，与上百条别的
判据混在一起。现在代码单独成仓（本仓），主仓只留一份判定逻辑真值。
本仓的相对布局与原位置**逐层一致**（`bin/` + `tools/`），所以文件里一条 import
路径都没改。
