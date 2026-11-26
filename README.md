# 会话医生

扫出 pi 会话里的可清理项，勾选后修掉。**每次写盘前整份备份，结构判据不过就拒绝写盘。**

三种入口：桌面安装包、命令行起网页、Electron 桌面壳。数据全读 `~/.pi/agent/sessions`。

## 立刻用

桌面上双击 `会话医生-安装.exe`，装完就是普通程序。

不想装，直接跑：

```bash
node bin/session-doctor.mjs              # 起本地网页并自动打开浏览器
node bin/session-doctor.mjs --no-open    # 只起服务
node bin/session-doctor.mjs --port 7799  # 指定端口
node bin/session-doctor.mjs --dir <目录> # 只扫这个目录（判据用它建沙箱）
```

Electron 桌面壳（需要本机有 Electron）：

```bash
node tools/session-doctor-desktop/setup-electron.mjs   # 找一份 Electron 进来
node tools/session-doctor-desktop/launch.mjs
```

## 能修什么

16 种判定，四种动作。**动作不同，风险不同，所以界面上分成四组复选框**——把它们混成「全部可折」会让人顺手改了协议必需的签名字段。

| 动作 | 改什么 | 判定 |
| --- | --- | --- |
| 删 | 整条 entry 从文件里去掉 | 空壳、重复快照、悬空编辑、孤立思考、空白正文、改写账本、旧改写 |
| 折 | 块内留头尾，块本身保留 | 重复图、长正文、长思考、长参数 |
| 摘块 | 只去掉没有结果的 toolCall，正文留着 | 死调用 |
| 接链 | **不删字节**，只把悬空 parentId 指回时间上前一条 | 断链 |
| 清字段 | **只删 thinkingSignature**，思考正文逐字不动 | 思考签名 |

两类只报告、不参与执行：脱链（父指针还在，但链上有环或更早的断口）、坏行（不是合法 JSON）。

为什么清签名要单独一类：它只对 Anthropic 协议必需，OpenAI 兼容协议完全忽略。清了签名再发请求，上游会 400——所以它必须是一个要人自己勾的框，不能混进「全部可折」。

## 界面

- **三层复选框**：全选 → 按动作（可删/可折/可接/可清）→ 按类（每个具体判定一个）。部分选中显示横杠；数字是真实条数（聚合项按它代表的条数算，写「思考签名 21942」而不是「1 行」）。
- **可拖分割**：侧栏右缘拖宽度（220–720px），日志上缘拖高度（60px–视口 72%）。双击复位，松手记住，下次打开还是这个尺寸。
- **日志累加**：只追加不覆盖，上限 400 行。扫描开始写分隔行，执行结果不会被随后那次重扫擦掉。
- 「执行」是按钮不是复选框——它是动作，不是选择。

## 扫描范围

只扫 `sessions/**/*.jsonl` 里**真的是 pi 会话**的文件。这三个目录下的不扫：

```
subagent-artifacts/   subagents/   pi-async/
```

它们放的是子代理运行记录与异步任务中间件，格式与 pi 会话不同（`recordType / role / text`，没有 `id`、没有 `parentId`）。2026-11-26 实测：把 `*_transcript.jsonl` 当会话扫进来，会报出「思考签名 32 条」，而执行时按 `id` 找不到目标（`cleaned=0`）、删除那一步却按下标把它整条删了。结构判据因此变红、拒绝写盘——那次拒绝挡住了误清理。

`bin/check-scan-scope.mjs` 挡这个：造一份真会话 + 一份子代理记录，断言只扫到前者。

## 判定逻辑不在本仓

`bin/lib/session-fix.mjs` 只有一行 `export * from`，真值在 `~/.pi/agent/bin/lib/session-fix.mjs`。

原因：那个文件的消费者是本机五个入口——`prune-session`、`fold-session`、会话医生界面、`check-session-fix-verify`、`check-context-edit`。复制一份进本仓，就要在两处分别维护「什么算异常」，迟早给出两个不同判决。所以本仓只做转发。

**路径层数**：`bin/lib/` 到 home 是三层（`../../../`）。数错一层会 import 到 `C:\Users\.pi\...`，界面一启动就 `ERR_MODULE_NOT_FOUND`，而语法检查全绿。`check-fix-source.mjs` 就是挡这个的。

**副作用**：本仓不是自包含的。clone 到没有 `~/.pi/agent` 的机器上，界面起不来。安装包不受影响——打包时从真值源复制实体文件，包里是完整的。

## 目录

```
bin/
  session-doctor.mjs      后端：HTTP + 扫描 + 执行（无依赖）
  session-doctor/         前端：preact + htm + TanStack virtual-core，纯 ESM 无构建
    index.html  app.js  components.js  store.js  api.js  format.js  kinds.js  app.css
    vendor/               前端依赖（preact/htm/virtual-core），直接进仓
    e2e-probe.cjs         E2E 探针
  lib/session-fix.mjs     ← 一行转发，见上
  check-fix-source.mjs    判据：转发路径能解析到真值
  check-scan-scope.mjs    判据：不扫子代理记录
  check-ui-script.mjs     判据：前端每个模块都能被 node 解析
  check-ui-e2e.mjs        判据：真起 Electron，48 条断言跑一遍主流程
tools/
  session-doctor-desktop/   Electron 壳（main.mjs 只做窗口 + 起后端）
  session-doctor-installer/ 打包：Electron 运行时 + app/ → 7z SFX → exe
gate.mjs                   总闸：glob 发现 bin/check-*.mjs 全跑
```

## 判据

```bash
node gate.mjs            # 全跑
node gate.mjs --fast     # 跳过 check-ui-e2e（要真起 Electron）
node gate.mjs --list     # 只列
```

退出码：0 全绿，1 有红，2 环境缺失（如没有 Electron——**不是通过**）。

新加判据不用登记：`gate.mjs` 用 glob 发现 `bin/check-*.mjs`。往 `bin/` 塞一个返回 1 的 `check-zzz-canary.mjs`，总闸必须变红并报出它。

## 打包

```bash
node tools/session-doctor-installer/build-installer.mjs            # 完整打包
node tools/session-doctor-installer/build-installer.mjs --layout   # 只生成布局
```

需要 7-Zip（`C:\Program Files\7-Zip\7z.exe`，可用 `SEVENZIP` 覆盖）和一份 Electron
运行时（自动找，可用 `SESSION_DOCTOR_ELECTRON_DIST` 指定 dist 目录）。
产物：`~/Desktop/会话医生-安装.exe`（约 92 MB）。

打包拒绝两种产物：
- `session-fix.mjs` 是转发而不是实体文件（装到别的机器上 import 会断）；
- 产物里有备份/临时文件（`*.bak` / `*.orig` / `*~` / `*.log`）。2026-11-26 实测：两个 `*.bak` 被一起拷进 `app/`，安装包里躺着 14490 字节的旧版本。

没用 electron-builder：本机 npm 12 报 `EALLOWREMOTE`，拒绝从 npmmirror 的 tarball 地址拉包。7z SFX 是等价物，产物同样是 exe，不依赖网络。代价是绿色版——没有「控制面板卸载」，删目录即卸载。

## 和 ~/.pi/agent 的关系

以前这些文件散在 `~/.pi/agent/bin/` 和 `~/.pi/agent/tools/` 里，与上百条别的判据混在一起。现在代码单独成仓（本仓），主仓只留一份判定逻辑真值。本仓的相对布局与原位置**逐层一致**（`bin/` + `tools/`），所以文件里一条 import 路径都没改。
