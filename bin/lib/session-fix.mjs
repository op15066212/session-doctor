/**
 * 判定逻辑的唯一源在 ~/.pi/agent/bin/lib/session-fix.mjs。
 *
 * 为什么不复制一份：同一个真值在两处各写一遍，改一边忘一边，两边就开始
 * 给出不同判决（比如「同一条会话，CLI 说可删，界面说不可删」）。这里是
 * 一行转发，改判据只改主仓那一个文件，CLI 与界面立刻同步。
 *
 * 路径层数：bin/lib/ → 仓根（..=bin, ../..=仓根, ../../..=home），共三层。
 * 数错一层就会 import 到 C:\Users\.pi 这种不存在的路径 —— 有判据盯着（check-fix-source.mjs）。
 *
 * 代价：本仓不是自包含的 —— clone 到没有 ~/.pi/agent 的机器上跑不起来。
 * 本机使用，README 已写明；安装包从真值源复制实体文件，不受此影响。
 */
export * from "../../../.pi/agent/bin/lib/session-fix.mjs";
