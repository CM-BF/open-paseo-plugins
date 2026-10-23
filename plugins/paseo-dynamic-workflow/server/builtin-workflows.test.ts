import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentOutcome, AgentTask } from "./agent-runner";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import type { StatePaths } from "./paths";
import { parseWorkflowScript } from "./script-parse";
import { cleanup, FakeRunner, ok, runScript } from "./test-harness";

const states: StatePaths[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) await cleanup(state);
});

async function run(name: string, behavior: (task: AgentTask) => AgentOutcome, args?: unknown) {
  const runner = new FakeRunner(behavior);
  const outcome = await runScript(BUILTIN_WORKFLOWS[name]!, runner, { args, concurrency: 4 });
  states.push(outcome.state);
  return { ...outcome, runner };
}

const failed: AgentOutcome = { ok: false, error: "provider error", skipped: false, worktree: null };

describe("built-in workflows", () => {
  it("are generated from workflows/*.js (run node scripts/build-reference.mjs)", () => {
    const dir = join(__dirname, "..", "workflows");
    const files = readdirSync(dir).filter((file) => file.endsWith(".js") && !file.startsWith("_")).sort();
    expect(Object.keys(BUILTIN_WORKFLOWS).sort()).toEqual(files.map((file) => file.slice(0, -3)));
    for (const file of files) expect(BUILTIN_WORKFLOWS[file.slice(0, -3)]).toBe(readFileSync(join(dir, file), "utf8"));
  });

  it("parse, carry their own name, and say when to use them", () => {
    expect(Object.keys(BUILTIN_WORKFLOWS).length).toBeGreaterThan(0);
    for (const [name, source] of Object.entries(BUILTIN_WORKFLOWS)) {
      const { meta } = parseWorkflowScript(source);
      expect(meta.name).toBe(name);
      expect(meta.whenToUse).toBeTruthy();
    }
  });

  it("deep-review verifies each new finding once, separates refuted from unverified, and stops after a dry gap round", async () => {
    const reviewFindings: Record<string, unknown[]> = {
      "review:correctness": [
        { title: "Off by one in pager", file: "src/pager.ts", line: 40, severity: "high", scenario: "last page is skipped" },
        { title: "Null config crashes start", file: "src/start.ts", line: 10, severity: "medium", scenario: "no config file" },
      ],
      // Same file and line bucket as the pager finding: deduplicated, not verified twice.
      "review:tests": [{ title: "Pager off-by-one", file: "src/pager.ts", line: 44, severity: "high", scenario: "dup" }],
      "review:security": [{ title: "Token logged", file: "src/log.ts", line: 3, severity: "critical", scenario: "debug log" }],
    };
    const { record, result, runner } = await run("deep-review", (task) => {
      const label = task.label;
      if (label === "scope") {
        return ok({
          summary: "Adds a pager",
          files: [{ path: "src/pager.ts", role: "new" }],
          dimensions: ["correctness", "tests", "security", "error-handling"].map((key) => ({ key, why: "applies" })),
        });
      }
      if (label.startsWith("review:")) return ok({ findings: reviewFindings[label] ?? [] });
      if (label.startsWith("critic:")) {
        return ok({ tasks: label === "critic:round-1" ? [{ key: "interaction", prompt: "Check pager with start" }] : [] });
      }
      if (label === "plan") return ok({ summary: "fix it", fixes: [] });
      // Verifiers: the pager finding is real, the null-config one is refuted, the token one has no valid votes.
      if (label.includes("Off by one")) return ok({ real: true, confidence: "high", reason: "traced" });
      if (label.includes("Null config")) return ok({ real: label.startsWith("reproduce"), confidence: "medium", reason: "guarded upstream" });
      if (label.includes("Token logged")) return label.startsWith("reproduce") ? ok({ real: true, confidence: "low", reason: "maybe" }) : failed;
      throw new Error(`unexpected agent ${label}`);
    }, { target: "branch sw/pager", votes: 3, rounds: 2 });

    expect(record.status).toBe("completed");
    const out = result as { confirmed: Array<{ title: string; votes: string }>; refuted: Array<{ title: string }>; unverified: Array<{ title: string }>; stats: { reviewed: number }; plan: unknown };
    expect(out.confirmed.map((f) => [f.title, f.votes])).toEqual([["Off by one in pager", "3-0"]]);
    expect(out.refuted.map((f) => f.title)).toEqual(["Null config crashes start"]);
    expect(out.unverified.map((f) => f.title)).toEqual(["Token logged"]);
    expect(out.stats.reviewed).toBe(3);
    expect(out.plan).toEqual({ summary: "fix it", fixes: [] });
    const labels = runner.tasks.map((task) => task.label);
    expect(labels.filter((label) => label.includes("Pager off-by-one"))).toEqual([]);
    // The gap round found nothing new, so the loop is dry and no second critic runs.
    expect(labels.filter((label) => label.startsWith("critic:"))).toEqual(["critic:round-1"]);
    expect(record.logs.map((line) => line.message)).toContain("Round 1: 1 targeted review(s), 0 new finding(s)");
    expect(labels).toContain("review:gap-1:interaction");
    expect(runner.tasks.filter((task) => task.opts.agentType === "verification")).toHaveLength(9);
  });

  it("deep-review stops before reviewing when scoping fails", async () => {
    const { result, runner } = await run("deep-review", () => failed, "review the diff");
    expect(result).toEqual({ error: expect.stringMatching(/scope agent returned nothing/) });
    expect(runner.tasks).toHaveLength(1);
  });

  it("deep-research dedupes sources and claims, counts failed votes as unverified, and cites confirmed claims", async () => {
    const { record, result, runner } = await run("deep-research", (task) => {
      const label = task.label;
      if (label === "scope") return ok({ angles: [{ label: "docs", query: "q1" }, { label: "bench", query: "q2" }] });
      if (label === "search:docs") return ok({ sources: [{ url: "https://a.example/x", title: "A", relevance: "high" }, { url: "https://www.a.example/x/", title: "A again", relevance: "low" }] });
      if (label === "search:bench") return ok({ sources: [{ url: "https://a.example/x?ref=1", title: "dup", relevance: "high" }, { url: "https://b.example/y", title: "B", relevance: "medium" }] });
      if (label === "read:a.example") return ok({ quality: "primary", claims: [{ claim: "X is fast", quote: "X is fast", weight: "central" }, { claim: "X is new", quote: "new", weight: "side" }] });
      if (label === "read:b.example") return ok({ quality: "secondary", claims: [{ claim: "X is fast", quote: "dup claim", weight: "central" }, { claim: "Y is cheap", quote: "cheap", weight: "supporting" }] });
      if (label.startsWith("verify")) {
        if (label.includes("X is fast")) return ok({ holds: true, confidence: "high", evidence: "measured" });
        if (label.includes("X is new")) return ok({ holds: false, confidence: "medium", evidence: "old" });
        return label.startsWith("verify1") ? ok({ holds: true, confidence: "low", evidence: "?" }) : failed;
      }
      if (label === "gaps") return ok({ angles: [] });
      if (label === "synthesize") return ok({ answer: "X is fast", findings: [{ finding: "X is fast", confidence: "high", sources: ["https://a.example/x"] }], caveats: [] });
      throw new Error(`unexpected agent ${label}`);
    }, { question: "Is X fast?", votes: 3 });
    expect(record.status).toBe("completed");
    const out = result as { answer: string; confirmed: Array<{ claim: string; votes: string }>; refuted: unknown[]; unverified: Array<{ claim: string }>; stats: Record<string, number> };
    expect(out.answer).toBe("X is fast");
    expect(out.confirmed).toEqual([expect.objectContaining({ claim: "X is fast", votes: "3-0" })]);
    expect(out.refuted).toHaveLength(1);
    expect(out.unverified.map((c) => c.claim)).toEqual(["Y is cheap"]);
    expect(out.stats).toMatchObject({ sources: 2, claimsVerified: 3 });
    expect(runner.tasks.filter((task) => task.label.startsWith("read:"))).toHaveLength(2);
    const fenced = runner.tasks.find((task) => task.label.startsWith("verify1:X is fast"))!.prompt;
    expect(fenced).toContain("<source-text>X is fast</source-text>");
  });

  it("deep-research reports an infrastructure failure when no vote is valid", async () => {
    const { result } = await run("deep-research", (task) => {
      if (task.label === "scope") return ok({ angles: [{ label: "a", query: "q" }, { label: "b", query: "q" }] });
      if (task.label.startsWith("search:")) return ok({ sources: [{ url: `https://${task.label.slice(7)}.example`, title: "t", relevance: "high" }] });
      if (task.label.startsWith("read:")) return ok({ quality: "primary", claims: [{ claim: `claim ${task.label}`, quote: "q", weight: "central" }] });
      if (task.label === "gaps") return ok({ angles: [] });
      return failed;
    }, "question");
    expect((result as { answer: string }).answer).toMatch(/infrastructure problem/);
  });

  it("design-panel ranks independent designs by mean judge score and synthesizes from the winner", async () => {
    const { result, runner } = await run("design-panel", (task) => {
      if (task.label.startsWith("draft:")) return ok({ title: `D${task.label.slice(6)}`, summary: "s", design: `design ${task.label}`, risks: [], steps: [] });
      if (task.label.startsWith("judge:")) {
        return ok({ scores: [0, 1].map((design) => ({ design, total: design === 1 ? 8 : 5, perCriterion: [], strengths: [`good ${design}`], flaws: [`flaw ${design}`] })) });
      }
      if (task.label === "synthesize") return ok({ title: "final", design: "d", steps: [], risks: [], grafted: [], rejected: [] });
      throw new Error(`unexpected agent ${task.label}`);
    }, { problem: "Pick a cache", angles: ["small", "robust"], judges: 2 });
    const out = result as { ranking: Array<{ title: string; mean: number }>; final: { title: string } };
    expect(out.ranking).toEqual([{ title: "D2", mean: 8, judged: 2 }, { title: "D1", mean: 5, judged: 2 }]);
    expect(out.final.title).toBe("final");
    expect(runner.tasks.find((task) => task.label === "synthesize")!.prompt).toContain("## Winner: D2");
  });
});
