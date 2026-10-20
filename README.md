# orchestrate

一个 DeepSeek Harness（DSH）原生的多 Agent 编排技能：**拆目标 → 排依赖 → 并行派发 → 独立验收 → 合并交付**。

它不是一个能跑起来的"框架"，而是一套给模型看的**方法论 + 可直接改的脚本配方**——执行层交给 DSH 自带的 `workflow` 工具，不重复造调度器。

## 为什么重写

原始版本 [multi-agent-orchestrator-skill](https://github.com/pxf0797/multi-agent-orchestrator-skill) 是为 Claude Code 写的。在 DSH 上实测：**技能包能加载，但跑到第三步就断**。

| 原设计依赖 | DSH 实际 |
|---|---|
| `TaskCreate` / `addBlockedBy` | 不存在 |
| `Agent(subagent_type, model, run_in_background)` | `subagent(prompt, description, cwd)` |
| `TeamCreate` 双向通信 | 不需要，`send_message` 已覆盖 |
| `~/.claude/orchestrator/` 文件树 | 不扫描、不该写 |
| haiku/sonnet/opus 分层 | DeepSeek 无此模型族 |

于是重写成：**方法层留在技能里，执行层交给 `workflow`**。

## 安装

用户级（所有项目可用）：

```bash
git clone https://github.com/pxf0797/orchestrate-skill.git ~/.dsh/skills/orchestrate
```

项目级（只在该项目生效）：

```bash
mkdir -p .dsh/skills && cp -R <本仓库> .dsh/skills/orchestrate
```

DSH 会自动发现（文件监听），无需重启。确认方式：新会话的技能目录里出现 `orchestrate`。

## 用法

自然语言触发即可：

```
帮我编排：对比 A/B/C 三个方案的取舍，出一份带来源的对比报告
并行调研这三家公司的定价策略
把这个仓库的 20 个模块逐个审计一遍
```

也可以显式点名：`用 orchestrate skill 处理……`

不适用：单个小任务、≤2 次委派——直接调用 `subagent` 更快。

## 设计

四个阶段：

```
Plan（自己做）  →  Dispatch（workflow 脚本）  →  Verify（独立 Agent）  →  Merge（交付）
   任务表+DAG         parallel / pipeline          light/standard/         汇总统计
                     schema 约束结果              strict/adversarial      产物落盘
```

四个验收级别、5 个可复制配方、6 个角色骨架、跨轮恢复与成本护栏。

关键约束（写进技能，防止模型犯常见错）：

- **只有顶层能做 fan-out**——子 Agent 深度上限为 1，不能嵌套编排。
- **子 Agent 看不到主对话**——prompt 必须自包含。
- **产出者不自评、verifier 不改东西、融合交给 writer**——防止自我批准。
- **不建事件流**——DSH 原生就在推流，额外写 JSONL 是重复建设。

## 文件结构

```
SKILL.md                124 行   四阶段协议、硬约束、反模式
references/
├── recipes.md          327 行   并行调研 / 代码开发 / 批量审计 / 对抗验证 / 方案选优
├── playbooks.md         93 行   4 个场景的阶段骨架
├── roles.md             82 行   6 个角色的提示词骨架
├── verify.md            81 行   验收判据与判决 schema
└── recovery.md          71 行   失败分级、重试预算、跨轮恢复
```

主文件只有 124 行：DSH 的 `skill` 工具按需加载，细节全部推给 references。

## 与内置工具的分工

| 工具 | 职责 |
|---|---|
| `orchestrate`（本技能） | 什么时候拆、怎么拆、拆完怎么验、什么算失败 |
| `workflow` | 真正的 DAG 执行：`phase` / `parallel` / `pipeline` / `schema` |
| `subagent` / `subagent_fork` | 单点委派；`send_message` 做运行中 steering |
| `ask_user_question` | 需要人决策时暂停 |
| `todo_write` | 人类可见的进度看板 |

## 已知限制

- 子 Agent 深度上限 1：编排只能在顶层发起。
- 子 Agent 的模型默认继承父级；要做模型分层需在 `workflow` 脚本里显式传 `provider`/`model`，且必须是已注册的模型。
- 跨轮恢复靠 `state.json`（技能会按需创建），不是框架级的持久化。
- 脚本里的 schema 只支持 JSON Schema 的一个子集（`type/properties/required/additionalProperties/items/enum/const/oneOf`），加 `description` 会导致整个脚本失败。

## License

MIT
