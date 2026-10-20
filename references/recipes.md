# workflow 脚本配方

把任务表翻成脚本时直接改这几份。全部遵守：`return` 有界、`agent()` 可能返回 `null`、schema 不含 `description`。
调用方式：`workflow(script=..., meta={name, description, phases}, args={...})`。

`meta` 示例：

```json
{
  "name": "research-fanout",
  "description": "多角度并行调研并汇总",
  "phases": [{ "title": "调研" }, { "title": "汇总" }]
}
```

---

## 1. 并行调研（扇出 → 汇总）

`args: { angles: ["技术路线", "生态与社区", "成本与许可"] }`

```js
const angles = args.angles;
if (!Array.isArray(angles) || angles.length === 0) throw new Error("args.angles 不能为空");

phase("调研");
const parts = await parallel(
  angles.map((a) => () =>
    agent(
      [
        `研究角度：${a}`,
        `要求：3-5 条结论，每条一句话并附来源 URL 与置信度（high|medium|low）；查不到就写"未找到"，不要编。`,
        `把完整笔记写入 ./notes-${a}.md；回复只返回不超过 200 字的摘要，不要贴全文。`
      ].join("\n"),
      { label: `scout:${a}`, phase: "调研" }
    )
  )
);

const blocks = parts
  .map((p, i) => (p ? `## ${angles[i]}\n${p}` : null))
  .filter(Boolean);
log(`有效角度 ${blocks.length}/${angles.length}`);
if (blocks.length === 0) return { ok: false, error: "所有调研 Agent 均失败" };

phase("汇总");
const report = await agent(
  [
    "把下列分角度摘要合并成一份报告：去重、标出互相矛盾的结论、保留来源。",
    "写文件 ./report.md，回复返回 150 字概要。",
    blocks.join("\n\n")
  ].join("\n\n"),
  { label: "merge", phase: "汇总" }
);

return { ok: true, angles: angles.length, usable: blocks.length, report };
```

要点：索引必须跟着 `angles` 走（`map((p, i) => …)`），否则失败项会让标题错位。

---

## 2. 代码开发（设计 → 并行实现 → 验收 → 集成）

`args: { spec: "给 /api/orders 加幂等键支持" }`

```js
const VERDICT = {
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
};

const PLAN = {
  type: "object",
  required: ["contracts", "modules"],
  additionalProperties: false,
  properties: {
    contracts: { type: "string" },
    modules: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "files", "done_when"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          done_when: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

phase("设计");
const plan = await agent(
  [
    `需求：${args.spec}`,
    "先读现有代码结构与约定，再输出模块拆分、接口契约（函数签名/数据结构/错误语义）、每个模块可改的文件白名单。",
    "模块之间不要共享可变状态；不改白名单外的文件。"
  ].join("\n"),
  { label: "architect", schema: PLAN, phase: "设计" }
);
if (!plan) return { ok: false, error: "architect failed" };

phase("实现");
const built = await parallel(
  plan.modules.map((m) => () =>
    agent(
      [
        `实现模块 ${m.name}。只允许改：${m.files.join(", ")}`,
        `接口契约：\n${plan.contracts}`,
        `完成标准：\n${m.done_when.map((d) => `- ${d}`).join("\n")}`,
        "完成后跑 typecheck 与相关测试，回复给出改动文件 + 自测输出。"
      ].join("\n"),
      { label: `build:${m.name}`, phase: "实现" }
    )
  )
);

phase("验收");
const verdict = await agent(
  [
    `验收需求：${args.spec}`,
    "逐条对照完成标准检查实现；只判不改。给出 pass/score/issues。",
    `模块完成标准：\n${JSON.stringify(plan.modules.map((m) => ({ name: m.name, done_when: m.done_when })), null, 2)}`
  ].join("\n"),
  { label: "verify", schema: VERDICT, phase: "验收" }
);
if (!verdict) return { ok: false, error: "verifier failed", built: built.filter(Boolean).length };
if (!verdict.pass) return { ok: false, verdict, built: built.filter(Boolean).length };

phase("集成");
const integration = await agent(
  "在完整仓库上跑测试与构建，修复集成层面的断裂（只改必要的胶水代码），回复给出命令与结果。",
  { label: "integrate", phase: "集成" }
);

return { ok: true, modules: plan.modules.length, verdict: verdict.summary, integration };
```

要点：`verdict.pass=false` 时**先返回**，把 `issues` 交给下一轮修正，不要在同一次脚本里反复自愈。

---

## 3. 批量审计（同构管道）

`args: { files: ["src/a.ts", "src/b.ts"] }`

```js
const FINDINGS = {
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["line", "problem", "fix"],
        additionalProperties: false,
        properties: {
          line: { type: "number" },
          problem: { type: "string" },
          fix: { type: "string" }
        }
      }
    }
  }
};

const results = await pipeline(
  args.files,
  (f) =>
    agent(`审查 ${f}：只报能指出具体行号的问题（空指针、越界、未处理错误、注入风险）。没有就返回空数组。`, {
      label: `scan:${f}`,
      phase: "扫描",
      schema: FINDINGS
    }),
  (prev, f) =>
    prev
      ? agent(`复核 ${f} 的这些发现，删掉误报，只留下能复现的：\n${JSON.stringify(prev.findings)}`, {
          label: `confirm:${f}`,
          phase: "复核",
          schema: FINDINGS
        })
      : null
);

const scanned = results.filter(Boolean);
const findings = scanned.flatMap((r) => r.findings);
return {
  files: args.files.length,
  scanned: scanned.length,
  total: findings.length,
  findings: findings.slice(0, 50)
};
```

要点：`pipeline` 阶段间没有栅栏，每个文件独立跑完两阶段；第二阶段必须处理 `prev === null`。

---

## 4. 对抗验证（3 票，只批判）

`args: { claim: "结论或产物路径", artifact: "./report.md" }`

```js
const VOTE = {
  type: "object",
  required: ["pass", "issues"],
  additionalProperties: false,
  properties: {
    pass: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "where", "problem"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          where: { type: "string" },
          problem: { type: "string" }
        }
      }
    }
  }
};

phase("对抗");
const votes = await parallel(
  [1, 2, 3].map((n) => () =>
    agent(
      [
        `你是独立审查者 ${n}。任务：推翻下面的结论，而不是附和。`,
        `待检对象：${args.claim}（文件 ${args.artifact}）`,
        "只找问题：证据不足、样本偏差、时间错配、来源不可靠、结论超出证据。",
        "禁止修改文件；禁止给修正建议；禁止综合他人意见。找到严重问题就 pass=false。"
      ].join("\n"),
      { label: `critic-${n}`, phase: "对抗", schema: VOTE }
    )
  )
);

const valid = votes.filter(Boolean);
const need = valid.length < 3 ? Math.floor(valid.length / 2) + 1 : 2;
const passVotes = valid.filter((v) => v.pass).length;
return {
  pass: valid.length > 0 && passVotes >= need,
  votes: `${passVotes}/${valid.length} 通过`,
  issues: valid.flatMap((v) => v.issues).slice(0, 30)
};
```

要点：有效票不足 3 时按实际票数取多数，并在结论里写明"少票"，不要假装满票。

---

## 5. 方案选优（opt-in，成本约 6x）

只在架构选型、关键算法这类高代价决策上用，且先跟用户确认成本。

```js
const LENS = ["最小改动与可维护性", "性能与扩展性", "错误处理与可观测性"];
const CMP = {
  type: "object",
  required: ["best", "reason", "borrow"],
  additionalProperties: false,
  properties: {
    best: { type: "number" },
    reason: { type: "string" },
    borrow: { type: "string" }
  }
};

phase("出方案");
const proposals = await parallel(
  LENS.map((lens, i) => () =>
    agent(
      `问题：${args.question}\n请只从「${lens}」这个视角给出完整方案，写 ./proposal-${i + 1}.md，回复 300 字摘要。`,
      { label: `propose-${i + 1}`, phase: "出方案" }
    )
  )
);

const list = proposals
  .map((p, i) => (p ? { id: i + 1, lens: LENS[i], text: p } : null))
  .filter(Boolean);

phase("评判");
const cmp = await agent(
  `比较以下方案，best 填编号，reason 说明为什么，borrow 指出次优方案里值得吸收的一点：\n` +
    list.map((p) => `#${p.id}（${p.lens}）\n${p.text}`).join("\n\n"),
  { label: "compare", phase: "评判", schema: CMP }
);

phase("融合");
const fusion = await agent(
  `以方案 #${cmp.best} 为主体，吸收这一点：${cmp.borrow}。产出一份可直接执行的单一方案，写 ./decision.md，回复 200 字摘要。`,
  { label: "fuse", phase: "融合" }
);

return { proposals: list.length, best: cmp.best, reason: cmp.reason, fusion };
```

要点：融合必须由独立 writer 做（这里是第三个 Agent），不要让评判者顺手改——那是自我批准。
