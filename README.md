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
| 折 | 块内留头尾，块本身保留 | 图片超限、重复图、长正文、长思考、长参数 |
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

## 图片超限：会让会话永久卡死的那一类

上游限单次请求的图片数（实测 20 张 200、21 张 400，报错 `Total number of images exceeds the maximum allowed of 20`）。
pi 每次请求带整条链的历史，所以链上累计超过 20 张之后，**每一轮请求都 400，连压缩请求都发不出去** ——
会话看起来完好，只是再也说不出话。

会话医生只数**当前链**（从最后一条沿 parentId 回溯，请求只发链上的内容），超出的从最老开始折成占位图，保留最近 20 张。
判据是「链上图片 <= 上限」——判会话能不能发出去，不是判折了几张。

| 层 | 在哪 | 改什么 | 判据 |
| --- | --- | --- | --- |
| 请求前裁 | `~/.pi/agent/extensions/magpie-image-cap.ts`（**不在本仓**，是 pi 插件） | 只动发出去的 payload，不改会话文件 | `~/.pi/agent/bin/check-image-cap.mjs`（**不在本仓**） |
| 文件里折 | 本仓「图片超限」这一类 | 改会话文件，折成占位，写盘生效 | `bin/check-anomaly-samples.mjs`（本仓，image-overflow 那一类） |

两层都要：插件让会话能继续用，但文件里的图还在；要真降下来（以及救那些连压缩都 400 的会话）只能改文件。

## 扫描范围

只扫 `sessions/**/*.jsonl` 里**真的是 pi 会话**的文件。这三个目录下的不扫：

```
subagent-artifacts/   subagents/   pi-async/
```

它们放的是子代理运行记录与异步中间件，格式与 pi 会话不同（`recordType / role / text`，没有 `id` / `parentId`）。把 `*_transcript.jsonl` 当会话扫进来，会报出一堆假异常，而执行时按 `id` 找不到目标。

`bin/check-scan-scope.mjs` 挡这个：造一份真会话 + 一份子代理记录，断言只扫到前者。

## 恢复了什么：thinking 块可以从备份回填

```bash
node bin/restore-thinking.mjs            # dry-run，只报能补多少
node bin/restore-thinking.mjs --write    # 写盘（改前先备份到 .session-backups）
```

用来回填被误删的 thinking 块。历史：2026-11-26 摘块函数没判断 kind，把 17 个会话共 22024 个 thinking 块整块摘掉，
而当时的判据只数签名字段 —— 签名归零、写盘一路绿灯。现在三条判据挡着（见「判据」一节）。

三条不许违反：

1. 行数不变（只改既有条目的 content）；
2. id 与 parentId 逐条不变（链不动，界面上的会话不会错位）；
3. 只补 thinking 正文，**不补 thinkingSignature**（签名本来就是清理对象）。

来源是「thinking 最多」的那份备份 —— 后来的备份可能本身就是被清过的。

## 判定逻辑不在本仓

`bin/lib/session-fix.mjs` 是**实体**（1155 行）：认异常与算结果的唯一实现。

本机 `~/.pi/agent/bin/lib/session-fix.mjs` 反而是一行转发指向这里——方向在 2026-11-27 调过来了。
原来反过来（本仓转发到私仓），于是克隆到任何别的机器 `import` 立刻 `ERR_MODULE_NOT_FOUND`，
10 条判据 7 条红。公开仓必须自带判定逻辑，私仓的十几个消费者 import 路径不变，内容从实体变成转发。

**路径层数**：`bin/lib/` 到 home 是三层（`../../../`）。数错一层会 import 到 `C:\Users\.pi\...`，界面一启动就 `ERR_MODULE_NOT_FOUND`，而语法检查全绿。`check-fix-source.mjs` 就是挡这个的。

**本仓自包含**：`git clone` 之后 `node gate.mjs` 直接可跑，不依赖 `~/.pi/agent`。

## 目录

```
bin/
  session-doctor.mjs      后端：HTTP + 扫描 + 执行（无依赖）
  session-doctor/         前端：preact + htm + TanStack virtual-core，纯 ESM 无构建
    index.html  app.js  components.js  store.js  api.js  format.js  kinds.js  app.css
    vendor/               前端依赖，直接进仓；e2e-probe.cjs 是 E2E 探针
  lib/session-fix.mjs     ← 实体：认异常与算结果都在这
  restore-thinking.mjs    从备份回填 thinking 块（改前备份，链不动）
  check-*.mjs             判据，清单见 `node gate.mjs --list`
tools/
  session-doctor-desktop/   Electron 壳（main.mjs 只做窗口 + 起后端）
  session-doctor-installer/ 打包：Electron 运行时 + app/ → 7z SFX → exe
gate.mjs                   总闸：glob 发现 bin/check-*.mjs 全跑
```

## 规则模型

依赖类型理论：每条规则有命题、证明项、反例、消去。直觉主义：成立要给居民，不用排中律代替证据。莫比乌斯反演：累积覆盖需先指名格与 μ；布尔格上的莫比乌斯反演用于独立子集，μ(S)=(−1)^|S|，即容斥。

| 构件 | 本仓落点 | 反例 |
| --- | --- | --- |
| 命题 | `bin/lib/session-fix.mjs` 的异常判定 | 文档写了代码不存在的异常 |
| 证明项 | `node gate.mjs` → rc=0；缺环境 rc=2 | 只报判据数量 |
| 反例 | `node gate.mjs --selftest` → rc=0 | 好样本绿、坏样本未红 |
| 消去 | `node bin/check-fix-source.mjs` → rc=0 | 私有转发路径指向错误实体 |

覆盖反演已落地：`bin/check-anomaly-coverage.mjs` 在候选集 n≤4 上先做 ζ 累积，再用布尔格 μ(S)=(−1)^|S| 反演成“恰好由哪些判据共同覆盖”。它只报告候选集，不把候选外的缺陷冒充已覆盖。

```bash
node bin/check-anomaly-coverage.mjs --selftest  # ζ/μ 互逆；三种坏实现各自变红
node bin/check-anomaly-coverage.mjs             # 报告恰好覆盖组合
```

## 判据

```bash
node gate.mjs            # 全跑
node gate.mjs --fast     # 跳过 check-ui-e2e（要真起 Electron）
node gate.mjs --list     # 只列
```

退出码：0 全绿，1 有红，2 环境缺失（如没有 Electron——**不是通过**）。

新加判据不用登记：`gate.mjs` 用 glob 发现 `bin/check-*.mjs`。往 `bin/` 塞一个返回 1 的 `check-zzz-canary.mjs`，总闸必须变红并报出它。

**本仓的判据只有 `bin/check-*.mjs` 这些。** 文中提到 `~/.pi/agent/bin/` 下的判据是私有仓的，
这台机器上有，克隆到别处没有——引它们时必须写明路径，否则读者会以为本仓自带。
2026-11-27 修：原表把三个私有仓判据写成「本仓」，与 pi-escape-guard 删掉的那份设计文档同一个病：文档指向不存在的东西。
判据：把 README 里每个反引号路径逐个 `test -e`，命中 0 处。

## 打包

```bash
node tools/session-doctor-installer/build-installer.mjs            # 完整打包
node tools/session-doctor-installer/build-installer.mjs --layout   # 只生成布局
```

需要 7-Zip（`C:\Program Files\7-Zip\7z.exe`，可用 `SEVENZIP` 覆盖）和一份 Electron
运行时（自动找，可用 `SESSION_DOCTOR_ELECTRON_DIST` 指定 dist 目录）。
产物：`~/Desktop/会话医生-安装.exe`（约 92 MB）。

打包拒绝两种产物：
- `bin/lib/session-fix.mjs` 是实体文件（2026-11-27 之前是转发，装到别的机器上 import 会断；已改）；
- 产物里有备份/临时文件（`*.bak` / `*.orig` / `*~` / `*.log`）。被一起拷进 `app/` 的那次，安装包里躺着一个 14490 字节的旧版本。

没用 electron-builder：本机 npm 12 报 `EALLOWREMOTE`，拒从 npmmirror 的 tarball 地址拉包。7z SFX 是等价物，产物同样是 exe，不依赖网络；代价是绿色版，删目录即卸载。

## 备份不会无界增长

每次写盘前把整份文件复制到 `.session-backups/<时间戳>/`。这份退路有保留策略：

- **留最近 10 份**（份数是硬上限）；
- 天数只是保底（默认 1 天：今天产生的退路今天不删）；
- 只清本工具写的那种时间戳目录，别人的（`chainfix-*` 之类）一概不碰；
- 清理失败不影响这次执行 —— 备份是退路，不是主线。

历史：此前只写不删，实测攒到 111 份 / 6.1 GB，其中 109 份在 24 小时内。判据在私有仓：`~/.pi/agent/bin/check-backup-retention.mjs`（**不在本仓**）。

