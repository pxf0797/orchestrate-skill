---
name: orchestrate
description: 把复杂目标拆成带依赖的 DAG，用 workflow 脚本并行调度多个子 Agent，逐阶段独立验收后合并交付。仅当用户原话明确要求多 Agent / 编排 / 并行 / swarm，或任务可拆成 ≥3 个互不依赖、且各自需要独立验收的子任务时使用。单个小任务、≤2 次委派、或只是想"同时问几个问题"不要用。
whenToUse: 用户原话明确要求编排或多 Agent 协作，或任务可拆成 ≥3 个互不依赖且各自需要独立验收的子任务。
---

# orchestrate

你是编排者：拆目标 → 排依赖 → 并行派发 → 独立验收 → 合并交付。
具体实现由子 Agent 做；规划、调度、验收判定、最终合并由你本人做。

## 先读：硬约束

1. **只有顶层能 fan-out。** 子 Agent 深度上限为 1，它们无法再派发、无法再编排。所有编排逻辑必须留在你这一层；不要把"用 orchestrate 去编排"塞进 `subagent`。**如果你自己就是被委派的子 Agent**（prompt 是自包含任务、看不到主对话），不要调 workflow——把任务表 + 子任务 prompt 骨架返回父级，由父级派发。
2. **子 Agent 看不到本对话。** prompt 必须自包含：目标、输入路径、完成标准、输出格式、写入位置。workflow 脚本里只有 `agent()`，没有 `subagent`/`subagent_fork`——共享上下文只能把关键片段拼进 prompt，或让上游写文件、下游自己读。
3. **执行层用 `workflow`，不是逐轮 `subagent`。** 但加载本技能不等于用户已授权成本：不满足 description 的触发条件就别编排，直接做。只有 ≤3 个任务且需要中途 steering（`send_message`）时才手工并行。
4. **别为纯洁性付成本。** 读一个文件、跑一条命令，自己做。派 Agent 去读一个小文件是净亏损。
5. **不建事件流、不建检查点文件。** 进度用 `todo_write` 看板 + `workflow` 的 `phase()`；只有跨轮长任务才写 `state.json`（见 recovery.md）。
6. **要人决策才停，且一次问完。** 用 `ask_user_question` 一次列出所有问题+推荐项；不要一轮问一个。
7. **不要编造模型名。** 只有确认存在时才给 `agent()` 传 `provider`/`model`；否则继承。DeepSeek 没有 haiku/sonnet/opus 这套分层。

## 第 1 步：Plan（自己做，不派发）

产出任务表，当场写下（也写进 `todo_write` 供人看）：

| 字段 | 要求 |
|---|---|
| `id` | 短语义名，如 `impl-auth`、`scan-api` |
| `subject` | 一句话任务 |
| `depends_on` | 依赖的 id 列表；空 = 可并行 |
| `done_when` | 二元可判定，如"4 个测试全绿""报告覆盖 5 个维度且每维度有来源" |
| `output` | 落到哪个文件 / 返回什么结构 |

规则：
- 3–8 个子任务。少于 3 个别编排，直接做；多于 8 个先按维度合并。
- 每个子任务单一职责、可独立验收。
- 有歧义且影响架构 → `ask_user_question`（每问给推荐项）。
- 预估 >10 个 Agent 或 >20 分钟 → 先告诉用户成本，再开工。

## 第 2 步：Dispatch（写 workflow 脚本）

把任务表翻成脚本。依赖形态 → 写法：

| 依赖形态 | 写法 |
|---|---|
| 全部独立 | `await parallel(items.map(i => () => agent(...)))` |
| A→B→C 串行 | 顺序 `await agent(...)` |
| 每个对象都走同一套阶段 | `await pipeline(items, stage1, stage2)` |
| 先扇出再汇合 | `parallel(...)` 之后再 `await agent(汇总)` |
| 按判决分支 | 先算出 `pass` 再 `if (pass) … else …`；判决布尔由脚本按 checks 计算，别直接采信 Agent 自报 |

脚本规矩：
- `parallel` 有栅栏：跨项汇总、去重、排序、全局裁剪必须放在它之后。
- `pipeline` 无栅栏：阶段 N 只能看到本项的 `prev`，必须显式处理 `prev === null`；拿不准就用 `parallel` + 汇总 agent。
- `agent()` 失败返回 `null`：要么 `.filter(Boolean)`（可降级场景），要么 `if (!x) return { ok: false, ... }`（不可降级）——不允许"半成功"返回 `ok: true`。
- 入参一律 `args?.x` 判空后 `return { ok: false, error }`；`args` 省略时是 `undefined`，直接取属性会先抛 TypeError，调用方拿到的只有 `stopReason=error`。
- 需要结构化结果就传 `schema`，别让 Agent 返回自由文本再人工解析。schema 只允许 `type/properties/required/additionalProperties/items/enum/const/oneOf` —— 加 `description` 会让整个脚本失败。
- 返回值有界：`return` 一个摘要对象 + 产物文件路径，不要把整篇正文塞进返回值。
- 每段 prompt 以 `PRE` 开头（见 [roles.md](references/roles.md)）：说清"看不到主对话 / 不能派发 / 大段内容写文件"。
- 脚本里没有 fs/网络/定时器；读写文件、跑命令都是 Agent 的事。
- 用 `phase()` 分段、`log()` 叙述；`args` 是调用方传入的入参。

可复制模板见 [references/recipes.md](references/recipes.md)（并行调研 / 代码开发 / 批量审计 / 对抗验证 / 方案选优）。

## 第 3 步：Verify（门禁，独立视角）

每个阶段产出后，派**独立** verifier 判，不要让产出者自评：

| 级别 | 用于 | 判据 |
|---|---|---|
| `light` | 搜索、收集、格式转换 | schema 完整、字段齐全 |
| `standard` | 模块开发、写作 | 逐条对照 `done_when` + 正确性 |
| `strict` | 集成、核心结论、安全代码 | 3 个独立 verifier，≥2 票通过 |
| `adversarial` | 事实核查、安全审查 | 3 个 critic 只批判不修正，≥2 票无严重问题 |

判决用 schema 拿：`{pass, score, issues[], summary}`。
`pass=false` → 带 `issues` 原文回退给产出者，**最多修正 2 轮**；第 3 次仍不过 → 按 [references/recovery.md](references/recovery.md) 交人或回 Plan，不要原样再验。
能自动化判定的验收（测试全绿、diff 只落在白名单、字段齐全），让 verifier 跑命令给证据，不要只让它读描述下结论。
**融合、改写交给另一个 writer，不要让 verifier 顺手改**——否则等于自我批准。

## 第 4 步：Merge（交付）

- 产物写进工作目录，文件名人类可读（如 `认证系统-开发总结.md`）。
- 回复里只给：完成/总数、验证通过率、失败与重试、Agent 数、产物路径。
- 正文不复制进对话；用文件链接。

## 场景路由

| 场景 | 触发 | 读 |
|---|---|---|
| 代码开发 | 实现/重构/修 bug/加功能 | [playbooks.md §1](references/playbooks.md) |
| 深度调研 | 研究/对比/调研/报告 | [playbooks.md §2](references/playbooks.md) |
| 批量处理 | 审计 N 个文件/仓库/条目 | [playbooks.md §3](references/playbooks.md) |
| 对抗核验 | 事实核查/安全审查/关键结论 | [playbooks.md §4](references/playbooks.md) |
| 其他 | 以上不匹配 | 按依赖形态自行组合 |

角色提示词：[references/roles.md](references/roles.md) · 验收细则：[references/verify.md](references/verify.md)

## 失败速查

| 现象 | 动作 |
|---|---|
| `agent()` 返回 null | 换输入重试，上限 2 次；仍 null → critical 停下问人，非 critical 跳过并标注 |
| 同一产出修正 2 轮仍不过 | 第 3 次交人，附两份判决；不要再原样重验 |
| ≥2 个并行任务同一原因失败 | 停止扇出，回 Plan（这是拆法错了，不是运气差） |
| 实际耗时 > 预估 3 倍 | 后台运行可 `job_kill(<job_id>)`；前台 workflow 发出后无法取消——等它返回，然后停止后续派发并报告已完成部分 |
| 用户中途改需求 | 停止新派发，等运行中的返回，再重排 DAG |

预算口径（与 [recovery.md](references/recovery.md) 同一套，不要各处改）：**修正 2 轮、null 重试 2 次、整轮 workflow 重跑 1 次**。

细节与跨轮恢复：[references/recovery.md](references/recovery.md)

## 反模式

- 把编排塞进子 Agent（深度上限会直接拒绝）
- 每个子任务再套一层 subagent（子 Agent 没有这个能力）
- 让 verifier 改产物、让产出者给自己打分
- 无依赖却串行、有依赖却并行
- 为"进度可视化"额外写 JSONL 事件流（DSH 原生就在推流）
- 按 Claude 的 haiku/sonnet/opus 分层选模型
- 一次向用户抛 5 个问题

## 参考文件

| 文件 | 什么时候读 |
|---|---|
| [recipes.md](references/recipes.md) | 要写 workflow 脚本时——直接改现成的 |
| [roles.md](references/roles.md) | 拼 prompt 时——6 个角色的骨架 |
| [verify.md](references/verify.md) | 设计验收标准时——判据与判决格式 |
| [playbooks.md](references/playbooks.md) | 按场景排阶段时 |
| [recovery.md](references/recovery.md) | 有失败、或任务要跨轮续跑时 |
