# 会话医生

扫描 pi 会话，列出可处理的异常；执行前创建整份备份，结构检查不通过就不写盘。

## 使用

桌面入口：运行 `会话医生-安装.exe`。

命令行入口：

```bash
node bin/session-doctor.mjs              # 启动网页并打开浏览器
node bin/session-doctor.mjs --no-open    # 只启动服务
node bin/session-doctor.mjs --port 7799  # 指定端口
node bin/session-doctor.mjs --dir <目录> # 只扫描指定目录
```

Electron 入口：

```bash
node tools/session-doctor-desktop/setup-electron.mjs
node tools/session-doctor-desktop/launch.mjs
```

数据目录默认是 `~/.pi/agent/sessions`。

## 处理类型

| 动作 | 处理内容 | 结果 |
| --- | --- | --- |
| 删 | 空条目、重复 system 快照、悬空改写、孤立 thinking、空白正文、无效改写 | 删除整条 entry |
| 折 | 重复图片、图片超限、长正文、长 thinking、长工具参数 | 保留头尾，中间换成占位内容 |
| 摘块 | 没有对应结果的 toolCall | 只移除 toolCall，保留同条正文 |
| 接链 | parentId 指向不存在的 entry | 只改 parentId，不删正文 |
| 清字段 | thinkingSignature | 只删字段，不删 thinking 正文 |

脱链和坏行只报告，不进入执行选择。清理 thinkingSignature 需要人工选择，因为不同模型协议对它的要求不同。

## 界面

- 三层复选框：全选、按动作、按具体判定；聚合项显示真实条数。
- 可拖动侧栏和日志区域；尺寸会保存。
- 日志只追加，最多保留 400 行。
- “执行”是动作按钮，不是复选框。

## 图片限制

会话请求使用当前链上的图片。链上图片数量超过供应商上限时，请求会失败；会话医生按链计算并从较早图片开始折叠，保留最近的图片。

| 层 | 位置 | 作用 | 检查 |
| --- | --- | --- | --- |
| 请求前裁剪 | `~/.pi/agent/extensions/magpie-image-cap.ts`（私有扩展） | 只修改请求 payload | `~/.pi/agent/bin/check-image-cap.mjs`（私有检查） |
| 文件折叠 | 本仓图片超限判定 | 修改会话文件 | `bin/check-anomaly-samples.mjs` |

## 扫描范围

只扫描 `sessions/**/*.jsonl` 中符合 pi 会话结构的文件，并排除：

```text
subagent-artifacts/
subagents/
pi-async/
```

`bin/check-scan-scope.mjs` 验证会话样本与子代理样本的范围差异。

## thinking 回填

`bin/restore-thinking.mjs` 从备份补回 thinking 正文：

```bash
node bin/restore-thinking.mjs
node bin/restore-thinking.mjs --write
```

写入必须满足：

1. 行数不变；
2. id 与 parentId 不变；
3. 只补 thinking 正文，不补 thinkingSignature。

## 判定源

`bin/lib/session-fix.mjs` 是异常判定和结果计算的唯一实现。仓库自包含，克隆后不依赖 `~/.pi/agent`。

死调用判定用两个索引集合计算差集，直接构造结果集合；同一条消息的多个调用分别对账，只摘除没有结果的调用。

`bin/check-fix-source.mjs` 检查判定源是实体文件，安装包不会带入转发路径。

## 规则模型

依赖类型理论：每条规则都有命题、证明项、反例、消去。直觉主义：成立必须给出居民，不能用“没有发现反例”代替证明。莫比乌斯反演：累积覆盖恢复逐项贡献时，先指名偏序与 μ。布尔格上的莫比乌斯反演使用 `μ(S)=(-1)^|S|`，也就是容斥。

| 构件 | 当前居民 | 反例 |
| --- | --- | --- |
| 命题 | `bin/lib/session-fix.mjs` 的异常判定 | 文档写出代码没有的异常 |
| 证明项 | `node gate.mjs` 返回 0 | 只报告检查数量 |
| 反例 | `node gate.mjs --selftest` | 只有正常样本通过 |
| 消去 | `node bin/check-fix-source.mjs` 返回 0 | 判定实体与入口路径不一致 |

覆盖检查在候选集 n≤4 上使用布尔格上的莫比乌斯反演，把“至少被覆盖”恢复为“恰好由哪些检查共同覆盖”。候选集以外不作覆盖结论。

```bash
node bin/check-anomaly-coverage.mjs --selftest
node bin/check-anomaly-coverage.mjs
```

## 检查

```bash
node gate.mjs            # 全部检查
node gate.mjs --fast     # 跳过需要 Electron 的 UI 检查
node gate.mjs --list     # 列出检查
```

退出码：0 表示没有红项；1 表示检查失败；2 表示环境缺失。

总闸通过 glob 发现 `bin/check-*.mjs`，新增检查不需要手工登记。

## 打包

```bash
node tools/session-doctor-installer/build-installer.mjs
node tools/session-doctor-installer/build-installer.mjs --layout
```

完整打包需要 7-Zip 和 Electron runtime，产物是桌面上的 `会话医生-安装.exe`。

打包会检查实体判定源，并排除 `*.bak`、`*.orig`、`*.tmp`、`*.log` 和 `*~` 文件。

## 备份

每次写盘前创建 `.session-backups/<时间戳>/`。只保留最近 10 份，并只清理本工具生成的备份目录。

## 文档与代码检查

```bash
node bin/check-doc-paths.mjs
node bin/check-fix-source.mjs
node bin/check-anomaly-coverage.mjs --selftest
node gate.mjs
```
