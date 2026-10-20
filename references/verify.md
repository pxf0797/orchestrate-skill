# 验收门禁

## 级别选择

| 级别 | 用于 | 谁判 | 判据 | 退回上限 |
|---|---|---|---|---|
| `light` | 搜索、收集、格式转换 | 1 个 verifier | schema 完整、必填字段齐、无占位符 | 1 |
| `standard` | 模块开发、写作、报告 | 1 个 verifier | 逐条对照 `done_when` + 正确性 + 完整性 | 2 |
| `strict` | 集成、核心结论、对外交付 | 3 个独立 verifier，≥2 票 | 同上 + 交叉验证 | 2 |
| `adversarial` | 事实核查、安全审查 | 3 个 critic，≥2 票"无严重问题" | 只批判不修正 | 2 |

默认 `standard`。不要给"读一个文件"这种动作配 verifier——验证成本高于产出时，验了就是亏。

退回上限按**修正轮次**计：`light` 为特例 1 轮，其余 2 轮。第 3 次仍不过就交人，不要原样重验（与 SKILL.md「失败速查」、recovery.md 同一口径，改一处要三处一起改）。

## 完成标准怎么写

`done_when` 必须是二元可判定的，不是形容词：

| 差 | 好 |
|---|---|
| "代码质量好" | "`pnpm test src/auth` 全绿" |
| "报告完整" | "覆盖 5 个维度，每维度 ≥3 条带来源结论" |
| "接口稳定" | "3 个调用方编译通过，无签名变更" |
| "性能达标" | "1000 并发 p95 < 200ms（附压测输出）" |

写不出二元标准，说明任务还没拆清楚，回 Plan。

## 判决格式

统一用这个 schema 收判决（`agent(..., {schema: VERDICT})`），不要自由文本：

```js
{
  type: "object",
  required: ["pass", "score", "issues", "summary"],
  additionalProperties: false,
  properties: {
    pass: { type: "boolean" },
    score: { type: "number" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "where", "problem", "fix"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          where: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" }
        }
      }
    },
    summary: { type: "string" }
  }
}
```

落盘版（需要人能直接读时）写 `verdict-<task>.json`，字段一致。

## 四条纪律

1. **产出者不自评。** 让 builder 检查自己的代码，等于没检查。必须是新 Agent、新上下文。
2. **verifier 不改东西。** 一旦允许它顺手修，它就会倾向于宣布"已修复"。修由 builder 做，verifier 只给 `issues`。
3. **融合交给 writer。** strict/adversarial 的票聚合成结论时，由 writer 写，不要让 verifier 综合——多份判决揉在一起最容易生出原文没有的结论。
4. **能跑就别只读。** 测试、`git diff --name-only`、编译这些可自动判定的，让 verifier 跑命令、把输出当 `evidence`；只凭描述下结论等于猜。

## 退回怎么带

`pass=false` 时，把 `issues` 原样回灌给产出者，别做二次概括：

```
上一轮验收未通过，逐条修完再交付：
1. [critical] src/auth/token.ts:42 — ttlSec=0 时 exp 早于签发时间；修法：小于等于 0 直接抛 INVALID_TTL
2. [major] 测试缺少负数 ttl 用例；修法：补 2 个参数化用例
不要改动范围外的文件。
```

## 什么时候不验

- 产出是纯信息收集，且下游 writer 会再读一遍（信息在汇总阶段自然被筛）。
- 任务本身是探索性的，验"对不对"没有意义，只需验"有没有"。
- 已经连续 2 次因同一标准被退回 → 不是再验的问题，是标准或拆法有问题，回 Plan 或交人。
