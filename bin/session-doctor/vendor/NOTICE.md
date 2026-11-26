# 第三方组件（vendor）

全部 MIT，随仓库附许可证原文。**不用 CDN、不用构建**：界面是纯静态 ESM，双击就能跑，
换台没网的机器也一样。版本与来源写在这里，升级时替换文件并更新本表。

| 文件 | 包 | 版本 | 体积 | 用途 |
|---|---|---|---|---|
| `preact.mjs` | `preact` | 10.29.8 | 12K | 视图层（3KB 级，比手写 DOM 少一半代码） |
| `htm.mjs` | `htm` | 3.1.1 | 4.0K | JSX 的替代：模板字符串，**不需要构建** |
| `virtual-core/index.js` + `utils.js` | `@tanstack/virtual-core` | 3.10.9 | 92K | 虚拟滚动（含动态测量、滚动锚定、rAF 节流） |

## 为什么是这三个

- **虚拟化不自己写**：手写一版能跑，但滚动锚定、动态行高、逆向滚动补偿这些边界情况
  要用几周才踩全。TanStack 那套是社区验证过的。
- **选 3.10.9 不选 3.19**：3.19 拆成 5 个模块（ios-gesture / scroll-classifier /
  lazy-measurements），309K，为固定行高列表带来的是复杂度不是能力。3.10.9 只有两个文件。
- **htm 不引入 Babel**：要 JSX 就得带构建步骤，而这个工具的价值之一是「双击就跑、
  换机器不用装东西」。htm 用模板字符串达到同样效果，零构建。

## 升级方法

```bash
cd /tmp && npm pack preact@10 htm@3 @tanstack/virtual-core@3.10.9
# 解包，替换对应文件，再跑：
node ../../bin/check-ui-script.mjs --selftest
node ../../bin/check-ui-state.mjs
```

许可证原文：`preact.LICENSE` / `htm.LICENSE` / `virtual-core.LICENSE`。
