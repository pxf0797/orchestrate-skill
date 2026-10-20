# workflow 脚本配方

五份可直接改的脚本。全部遵守四条铁律：

1. 每个 `agent()` prompt 以 `PRE` 开头（子 Agent 看不到主对话、不能派发、回复有界）。
2. 入参一律 `args?.x` 判空后 `return { ok: false, error }`；`args` 省略时是 `undefined`。
3. `agent()` 返回 `null` 必须处理：能降级就 `.filter(Boolean)`，不能降级就 `return { ok: false }`。
4. `schema` 只含 `type/properties/required/additionalProperties/items/enum/const/oneOf`——加 `description` 会让整个脚本失败。

调用方式：`workflow(script=..., meta={name, description, phases}, args={...})`。
`meta` 示例：

```json
{
  "name": "research-fanout",
  "description": "多角度并行调研并汇总",
  "phases": [{ "title": "调研" }, { "title": "汇总" }]
}
```

公共前缀（每份脚本里都带一份，保证可独立复制）：

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");
```

---

## 1. 并行调研（扇出 → 汇总）

`args: { angles: ["技术路线", "生态与社区", "成本与许可"] }`

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");

const angles = args?.angles;
if (!Array.isArray(angles) || angles.length === 0) return { ok: false, error: "args.angles 不能为空" };

phase("调研");
const parts = await parallel(
  angles.map((a) => () =>
    agent(
      [
        PRE,
        "",
        `研究角度：${a}`,
        `要求：3-5 条结论，每条一句话并附来源 URL 与置信度（high|medium|low）；查不到就写"未找到"，不要编。`,
        `把完整笔记写入 ./notes-${a}.md。`
      ].join("\n"),
      { label: `scout:${a}`, phase: "调研" }
    )
  )
);

const blocks = parts
  .map((p, i) => (p ? `## ${angles[i]}\n${p}` : null))
  .filter(Boolean);
log(`有效角度 ${blocks.length}/${angles.length}`);
if (blocks.length === 0) return { ok: false, error: "所有调研 Agent 均失败", angles: angles.length };

phase("汇总");
const report = await agent(
  [
    PRE,
    "",
    "把下列分角度摘要合并成一份报告：去重、标出互相矛盾的结论、保留来源。写文件 ./report.md。",
    blocks.join("\n\n")
  ].join("\n\n"),
  { label: "merge", phase: "汇总" }
);
if (!report) {
  log("汇总失败，保留分角度笔记");
  return { ok: false, error: "merge failed", angles: angles.length, usable: blocks.length };
}

return { ok: true, angles: angles.length, usable: blocks.length, report };
```

要点：索引必须跟着 `angles` 走（`map((p, i) => …)`），否则失败项会让标题错位。

---

## 2. 代码开发（设计 → 并行实现 → 验收 → 集成 + 三票）

`args: { spec: "给 /api/orders 加幂等键支持" }`

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");

const spec = args?.spec;
if (!spec) return { ok: false, error: "args.spec 不能为空" };

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

const CHECKS = {
  type: "object",
  required: ["checks", "summary"],
  additionalProperties: false,
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["module", "criterion", "evidence", "satisfied"],
        additionalProperties: false,
        properties: {
          module: { type: "string" },
          criterion: { type: "string" },
          evidence: { type: "string" },
          satisfied: { type: "boolean" }
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
    PRE,
    "",
    `需求：${spec}`,
    "先读现有代码结构与约定，再输出模块拆分、接口契约（函数签名/数据结构/错误语义）、每个模块可改的文件白名单。",
    "模块之间不要共享可变状态；不改白名单外的文件；不同模块的文件白名单必须互斥。"
  ].join("\n"),
  { label: "architect", schema: PLAN, phase: "设计" }
);
if (!plan) return { ok: false, stage: "设计", error: "architect failed" };
if (!Array.isArray(plan.modules) || plan.modules.length === 0) {
  return { ok: false, stage: "设计", error: "未拆出模块" };
}

// 白名单互斥：同一文件分给两个模块，并行写入会互相覆盖
const owner = new Map();
for (const m of plan.modules) {
  for (const f of m.files) {
    const prev = owner.get(f);
    if (prev && prev !== m.name) {
      return { ok: false, stage: "设计", error: `文件 ${f} 同时分配给 ${prev} 和 ${m.name}` };
    }
    owner.set(f, m.name);
  }
}

phase("实现");
const built = await parallel(
  plan.modules.map((m) => () =>
    agent(
      [
        PRE,
        "",
        `实现模块 ${m.name}。只允许改：${m.files.join(", ")}`,
        `接口契约：\n${plan.contracts}`,
        `完成标准：\n${m.done_when.map((d) => `- ${d}`).join("\n")}`,
        "需要改白名单外的文件就停下报告，不要越界。",
        "完成后跑 typecheck 与相关测试，回复给出改动文件 + 自测命令与关键输出。"
      ].join("\n"),
      { label: `build:${m.name}`, phase: "实现" }
    )
  )
);

const builtOk = built.filter(Boolean);
if (builtOk.length < plan.modules.length) {
  return {
    ok: false,
    stage: "实现",
    error: "builder 缺失",
    missing: plan.modules.length - builtOk.length
  };
}

phase("验收");
const verdict = await agent(
  [
    PRE,
    "",
    `验收需求：${spec}`,
    "先跑 `git diff --name-only` 拿到改动文件；每个文件必须落在对应模块白名单内，越界记 critical。",
    "逐条对照完成标准并跑测试；每条给 evidence（命令 + 关键输出）。只判不改。",
    `模块与白名单：\n${JSON.stringify(
      plan.modules.map((m) => ({ name: m.name, files: m.files, done_when: m.done_when })),
      null,
      2
    )}`,
    `builder 自述：\n${builtOk.join("\n\n---\n\n")}`
  ].join("\n"),
  { label: "verify", schema: CHECKS, phase: "验收" }
);
if (!verdict) return { ok: false, stage: "验收", error: "verifier failed" };

const pass = verdict.checks.length > 0 && verdict.checks.every((c) => c.satisfied);
if (!pass) {
  return {
    ok: false,
    stage: "验收",
    summary: verdict.summary,
    issues: verdict.checks.filter((c) => !c.satisfied)
  };
}

phase("集成");
const integration = await agent(
  [
    PRE,
    "",
    "在完整仓库上跑测试与构建。只允许改胶水（import/导出/配置/CI），禁止改 public 契约、禁止跑数据库迁移、禁止 git push。",
    "回复给出：执行的命令、结果、以及 `git diff --name-only` 的输出。"
  ].join("\n"),
  { label: "integrate", phase: "集成" }
);
if (!integration) return { ok: false, stage: "集成", error: "integration failed" };

phase("集成核验");
const votes = await parallel(
  [1, 2, 3].map((n) => () =>
    agent(
      [
        PRE,
        "",
        `你是集成验收者 ${n}。自己跑测试与构建，并核对改动是否只落在胶水文件、契约是否被改动。`,
        `集成者回报：\n${integration}`,
        "只判不改：给出 pass / score / issues。"
      ].join("\n"),
      { label: `集成票-${n}`, phase: "集成核验", schema: VERDICT }
    )
  )
);

const iv = votes.filter(Boolean);
const passVotes = iv.filter((v) => v.pass).length;
if (iv.length < 2 || passVotes < 2) {
  return {
    ok: false,
    stage: "集成",
    votes: `${passVotes}/${iv.length}`,
    issues: iv.flatMap((v) => v.issues).slice(0, 20)
  };
}

return {
  ok: true,
  modules: plan.modules.length,
  checks: verdict.checks.length,
  votes: `${passVotes}/${iv.length}`,
  integration
};
```

要点：`pass` 由脚本按 `checks.every(satisfied)` 算，不采信 Agent 自报的布尔值；集成必须过三票，模块级通过不等于交付。

---

## 3. 批量审计（同构管道，分批）

`args: { files: ["src/a.ts", "src/b.ts"], offset?: 0 }`

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");

const all = args?.files;
if (!Array.isArray(all) || all.length === 0) return { ok: false, error: "args.files 不能为空" };

// 每个文件两个 Agent：单批 10 个文件 = 20 个 Agent，与 recovery.md 的上限对齐
const MAX = 10;
const offset = typeof args?.offset === "number" ? args.offset : 0;
const files = all.slice(offset, offset + MAX);
if (files.length === 0) return { ok: false, error: "offset 超出范围", total: all.length };
log(`处理 ${offset}..${offset + files.length} / ${all.length}`);

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
  files,
  (f) =>
    agent(
      [PRE, "", `审查 ${f}：只报能指出具体行号的问题（空指针、越界、未处理错误、注入风险）。没有就返回空数组。`].join("\n"),
      { label: `scan:${f}`, phase: "扫描", schema: FINDINGS }
    ),
  (prev, f) =>
    prev
      ? agent(
          [PRE, "", `复核 ${f} 的这些发现，删掉误报，只留下能复现的：\n${JSON.stringify(prev.findings)}`].join("\n"),
          { label: `confirm:${f}`, phase: "复核", schema: FINDINGS }
        )
      : null
);

const scanned = results.filter(Boolean);
const findings = scanned.flatMap((r) => r.findings);
const next = offset + files.length < all.length ? offset + files.length : null;

return {
  total: all.length,
  processed: files.length,
  scanned: scanned.length,
  findingsTotal: findings.length,
  findings: findings.slice(0, 50),
  next
};
```

要点：`pipeline` 阶段间没有栅栏，每个文件独立跑完两阶段；第二阶段必须处理 `prev === null`。`next` 非空时用 `args.offset` 续跑，不要一次塞全部文件。

---

## 4. 对抗验证（3 票，只批判）

`args: { claim: "结论或产物路径", artifact: "./report.md" }`

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");

const claim = args?.claim;
const artifact = args?.artifact;
if (!claim || !artifact) return { ok: false, error: "args.claim / args.artifact 不能为空" };

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
        PRE,
        "",
        `你是独立审查者 ${n}。任务：推翻下面的结论，而不是附和。`,
        `待检对象：${claim}（文件 ${artifact}）`,
        "只找问题：证据不足、样本偏差、时间错配、来源不可靠、结论超出证据。",
        "禁止修改文件；禁止给修正建议；禁止综合他人意见。找到严重问题就 pass=false。"
      ].join("\n"),
      { label: `critic-${n}`, phase: "对抗", schema: VOTE }
    )
  )
);

const valid = votes.filter(Boolean);
const passVotes = valid.filter((v) => v.pass).length;
const issues = valid.flatMap((v) => v.issues).slice(0, 30);

// 有效票不足 2 时一律不通过：不能让"弄挂两个 critic"变成放行手段
if (valid.length < 2) {
  return { pass: false, votes: `${passVotes}/${valid.length}（有效票不足 2）`, issues };
}

return { pass: passVotes >= 2, votes: `${passVotes}/${valid.length} 通过`, issues };
```

要点：有效票 <2 一律 `pass=false`，不得按多数放行；结论里如实写票数，不要按满票表述。

---

## 5. 方案选优（opt-in，成本约 6x）

只在架构选型、关键算法这类高代价决策上用，且先跟用户确认成本。

`args: { question: "幂等键应该放在网关还是订单服务" }`

```js
const PRE = [
  "你看不到主对话，本 prompt 就是全部信息；缺信息用工具查，查不到写「未确认」。",
  "你不能派发子 Agent，不能调用 workflow。",
  "大段内容写文件并给路径，回复不超过 200 字。"
].join("\n");

const question = args?.question;
if (!question) return { ok: false, error: "args.question 不能为空" };

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
      [PRE, "", `问题：${question}`, `请只从「${lens}」这个视角给出完整方案，写 ./proposal-${i + 1}.md，回复 300 字摘要。`].join("\n"),
      { label: `propose-${i + 1}`, phase: "出方案" }
    )
  )
);

const list = proposals
  .map((p, i) => (p ? { id: i + 1, lens: LENS[i], text: p } : null))
  .filter(Boolean);
if (list.length === 0) return { ok: false, error: "所有方案 Agent 均失败", proposals: 0 };

phase("评判");
const cmp = await agent(
  [
    PRE,
    "",
    "比较以下方案：best 填编号（必须是给出的编号之一），reason 说明为什么，borrow 指出次优方案里值得吸收的一点。",
    list.map((p) => `#${p.id}（${p.lens}）\n${p.text}`).join("\n\n")
  ].join("\n"),
  { label: "compare", phase: "评判", schema: CMP }
);
if (!cmp) return { ok: false, error: "compare failed", proposals: list.length };

// 模型可能编一个不存在的编号，回退到第一个方案
const bestId = list.some((p) => p.id === cmp.best) ? cmp.best : list[0].id;

phase("融合");
const fusion = await agent(
  [
    PRE,
    "",
    `以方案 #${bestId} 为主体，吸收这一点：${cmp.borrow}。`,
    "产出一份可直接执行的单一方案，写 ./decision.md，回复 200 字摘要。"
  ].join("\n"),
  { label: "fuse", phase: "融合" }
);
if (!fusion) {
  return { ok: false, error: "fuse failed", proposals: list.length, best: bestId, reason: cmp.reason };
}

return { ok: true, proposals: list.length, best: bestId, reason: cmp.reason, fusion };
```

要点：融合必须由独立 writer 做（这里是第三个 Agent），不要让评判者顺手改——那是自我批准。
