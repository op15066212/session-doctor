# 会话医生

扫描 pi 会话并列出可处理的异常。执行前创建完整备份；结构检查失败时不写入。

## 运行

桌面版运行 `会话医生-安装.exe`。命令行：

```bash
node bin/session-doctor.mjs
node bin/session-doctor.mjs --no-open
node bin/session-doctor.mjs --port 7799
node bin/session-doctor.mjs --dir <目录>
```

默认扫描 `~/.pi/agent/sessions`。Electron 开发入口：

```bash
node tools/session-doctor-desktop/setup-electron.mjs
node tools/session-doctor-desktop/launch.mjs
```

## 判定与处理

| 操作 | 处理内容 | 写入范围 |
| --- | --- | --- |
| 删除 | 空调用、重复 system 快照、悬空改写、孤立 thinking、空白正文、无效改写 | 删除匹配 entry |
| 折叠 | 重复图片、图片超限、过长正文/thinking/tool 参数 | 保留头尾并写占位内容 |
| 摘除调用块 | 没有对应结果的 toolCall | 只移除该块，保留同条其他内容 |
| 修复父链 | parentId 指向不存在的 entry | 只改 parentId，不删正文 |
| 清理签名 | thinkingSignature | 只删字段，不删 thinking 正文 |

坏行和断链只报告，不进入执行选择。清理 thinkingSignature 需要显式选择，因为不同 provider 的协议要求不同。

写盘前在 `.session-backups/<时间戳>/` 创建备份，只保留最近 10 份，并且只清理本工具创建的备份目录。

## 扫描边界

只扫描符合 pi 会话结构的 `sessions/**/*.jsonl`，排除 `subagent-artifacts/`、`subagents/` 和 `pi-async/`。`bin/check-scan-scope.mjs` 用样本验证范围。

图片上限按当前会话链计算；超限时从较早图片开始折叠，保留最近图片。此处是文件修复。请求前裁剪由私有扩展 `~/.pi/agent/extensions/magpie-image-cap.ts` 单独处理，不能与本仓文件修复混为一项。

## 数据还原

`bin/restore-thinking.mjs` 可从备份补回 thinking 正文：

```bash
node bin/restore-thinking.mjs
node bin/restore-thinking.mjs --write
```

写回检查行数、id、parentId 不变，并且只补 thinking 正文，不补 thinkingSignature。

## 实现与覆盖

`bin/lib/session-fix.mjs` 是异常判定和结果计算的唯一实现；仓库自包含。死调用通过 call id 与 result id 两个集合求差，同一消息中只摘除没有结果的调用。`bin/check-fix-source.mjs` 检查安装包使用实体实现，而非转发路径。

覆盖判据在候选集 `n≤4` 上使用布尔格 Möbius 反演：先从“至少被哪些检查覆盖”的累积量恢复“恰由哪些检查覆盖”的逐项贡献。候选集以外不作覆盖结论。

依赖类型理论要求规则包含命题、证明项、反例和消去；直觉主义要求用可运行命令与具体坏样本作证。此处的命令入口如下：

```bash
node bin/check-anomaly-coverage.mjs --selftest
node bin/check-anomaly-coverage.mjs
node gate.mjs --list
```

## 检查与打包

```bash
node gate.mjs
node gate.mjs --fast
node bin/check-doc-paths.mjs
node bin/check-fix-source.mjs
node tools/session-doctor-installer/build-installer.mjs
```

退出码 `0` 表示无红项，`1` 表示检查失败，`2` 表示环境缺失。总闸通过 glob 发现 `bin/check-*.mjs`。完整安装包需要 7-Zip 与 Electron runtime，产物为桌面上的 `会话医生-安装.exe`；打包排除备份、临时文件和日志。
