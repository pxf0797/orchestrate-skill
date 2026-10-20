import { readFile } from "node:fs/promises";

const md = await readFile(new URL("../references/recipes.md", import.meta.url), "utf8");
const blocks = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
const by = (sig) => blocks.find((b) => b.includes(sig) && b.includes("return {"));

const RECIPES = {
  research: by("args?.angles"),
  code: by("args?.spec"),
  audit: by("args?.files"),
  adversarial: by("args?.claim"),
  tournament: by("args?.question"),
};

for (const [k, v] of Object.entries(RECIPES)) if (!v) throw new Error("missing block: " + k);

const phase = () => {};
const log = () => {};
const parallel = (thunks) => Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));
const pipeline = (items, ...stages) =>
  Promise.all(items.map(async (item, i) => {
    let prev = item;
    try {
      for (const s of stages) prev = await s(prev, item, i);
      return prev;
    } catch { return null; }
  }));

function compile(body) {
  return new Function("agent", "parallel", "pipeline", "phase", "log", "args", "return (async () => {\n" + body + "\n})();");
}

async function run(name, args, agentImpl) {
  const fn = compile(RECIPES[name]);
  return await fn(agentImpl, parallel, pipeline, phase, log, args);
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label + (extra ? " :: " + JSON.stringify(extra) : "")); }
}

// ---------- §1 调研 ----------
console.log("§1 并行调研");
let r = await run("research", undefined, async () => "x");
check("缺 args 返回结构化错误", r.ok === false && /angles/.test(r.error), r);

r = await run("research", { angles: ["a", "b"] }, async (p, o) => (o.label === "merge" ? null : "note"));
check("merge 失败不再返回 ok:true", r.ok === false && r.error === "merge failed" && r.usable === 2, r);

r = await run("research", { angles: ["a"] }, async () => null);
check("全部失败返回错误", r.ok === false && /均失败/.test(r.error), r);

r = await run("research", { angles: ["a", "b"] }, async (p, o) => (o.label === "merge" ? "report" : "n"));
check("成功路径带 ok:true", r.ok === true && r.usable === 2 && r.report === "report", r);

// ---------- §2 代码开发 ----------
console.log("§2 代码开发");
r = await run("code", undefined, async () => "x");
check("缺 args 返回结构化错误", r.ok === false && /spec/.test(r.error), r);

r = await run("code", { spec: "s" }, async (p, o) => {
  if (o.label === "architect") return { contracts: "c", modules: [
    { name: "A", files: ["x.ts"], done_when: ["d"] },
    { name: "B", files: ["x.ts"], done_when: ["d"] },
  ] };
  return "x";
});
check("白名单冲突被拦截", r.ok === false && /同时分配/.test(r.error), r);

r = await run("code", { spec: "s" }, async (p, o) => {
  if (o.label === "architect") return { contracts: "c", modules: [
    { name: "A", files: ["a.ts"], done_when: ["d"] },
    { name: "B", files: ["b.ts"], done_when: ["d"] },
  ] };
  if (o.label.startsWith("build:")) return "built " + o.label;
  if (o.label === "verify") return { checks: [{ module: "A", criterion: "d", evidence: "test ok", satisfied: true }], summary: "ok" };
  if (o.label === "integrate") return "integr all";
  if (o.label.startsWith("集成票-")) return { pass: true, score: 90, issues: [], summary: "ok" };
  return "x";
});
check("成功路径返回 ok:true + 三票", r.ok === true && r.votes === "3/3", r);

r = await run("code", { spec: "s" }, async (p, o) => {
  if (o.label === "architect") return { contracts: "c", modules: [{ name: "A", files: ["a.ts"], done_when: ["d"] }] };
  if (o.label.startsWith("build:")) return "built";
  if (o.label === "verify") return { checks: [{ module: "A", criterion: "d", evidence: "e", satisfied: false }], summary: "bad" };
  return "x";
});
check("checks 不满足走失败分支", r.ok === false && r.stage === "验收", r);

r = await run("code", { spec: "s" }, async (p, o) => {
  if (o.label === "architect") return { contracts: "c", modules: [{ name: "A", files: ["a.ts"], done_when: ["d"] }] };
  if (o.label.startsWith("build:")) return "built";
  if (o.label === "verify") return { checks: [{ module: "A", criterion: "d", evidence: "e", satisfied: true }], summary: "ok" };
  if (o.label === "integrate") return "done";
  if (o.label.startsWith("集成票-")) return { pass: false, score: 10, issues: [{ severity: "critical", where: "x", problem: "p", fix: "f" }], summary: "no" };
  return "x";
});
check("集成三票不过被拦截", r.ok === false && r.stage === "集成", r);

// ---------- §3 批量审计 ----------
console.log("§3 批量审计");
r = await run("audit", undefined, async () => "x");
check("缺 args 返回结构化错误", r.ok === false && /files/.test(r.error), r);

const files25 = Array.from({ length: 25 }, (_, i) => "f" + i);
r = await run("audit", { files: files25 }, async () => ({ findings: [] }));
check("25 个文件只跑 10 个并给 next", r.processed === 10 && r.next === 10 && r.total === 25, r);

r = await run("audit", { files: files25, offset: 20 }, async () => ({ findings: [] }));
check("末批 next 为 null", r.processed === 5 && r.next === null, r);

// ---------- §4 对抗 ----------
console.log("§4 对抗验证");
r = await run("adversarial", undefined, async () => "x");
check("缺 args 返回结构化错误", r.ok === false && /claim/.test(r.error), r);

r = await run("adversarial", { claim: "c", artifact: "a" }, async () => ({ pass: true, issues: [] }));
check("3 票全过", r.pass === true && /3\/3/.test(r.votes), r);

r = await run("adversarial", { claim: "c", artifact: "a" }, async (p, o) =>
  o.label === "critic-1" ? { pass: true, issues: [] } : null
);
check("只剩 1 张有效票不得放行", r.pass === false && /不足 2/.test(r.votes), r);

r = await run("adversarial", { claim: "c", artifact: "a" }, async (p, o) =>
  o.label === "critic-3" ? null : { pass: o.label === "critic-1", issues: [] }
);
check("2 票中 1 票过不得放行", r.pass === false, r);

// ---------- §5 选优 ----------
console.log("§5 方案选优");
r = await run("tournament", undefined, async () => "x");
check("缺 args 返回结构化错误", r.ok === false && /question/.test(r.error), r);

r = await run("tournament", { question: "q" }, async (p, o) => {
  if (o.label.startsWith("propose-")) return "prop " + o.label;
  if (o.label === "compare") return { best: 99, reason: "r", borrow: "b" };
  return "fusion";
});
check("越界 best 编号回退到第一个方案", r.ok === true && r.best === 1, r);

r = await run("tournament", { question: "q" }, async (p, o) => {
  if (o.label.startsWith("propose-")) return null;
  return "x";
});
check("全部方案失败返回错误", r.ok === false && r.proposals === 0, r);

r = await run("tournament", { question: "q" }, async (p, o) => {
  if (o.label.startsWith("propose-")) return "prop";
  if (o.label === "compare") return null;
  return "x";
});
check("compare 失败不崩溃", r.ok === false && r.error === "compare failed", r);

console.log("\n结果: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
