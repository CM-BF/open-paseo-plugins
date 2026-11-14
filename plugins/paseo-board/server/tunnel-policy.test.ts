import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error standalone runtime
import { initializeApp } from "../backend/scaffold.mjs";
import { boardInstructions, skillMarkdown } from "./prompts";
import { toolDefinitions } from "./runtime";
import { RUNTIME_SOURCE } from "./runtime-source";
import { wakePrompt } from "./inbox-auto";
import { assistantSystemPrompt } from "./inbox-assistant";

/**
 * Reachability of a comment backend is the human's deployment decision. Nothing in this plugin may start,
 * configure, recommend or document a way to expose a local service publicly (DESIGN §11.14). The only
 * permitted mention is the one prohibition sentence in the agent-facing skill text.
 */
const ALLOWED = "Never open public tunnels or otherwise expose a local service beyond this machine; the comment backend's API origin is chosen and deployed by the user, and you only use the address they give you.";
const TIER1 = /tunnel|ngrok|cloudflared|localtunnel|serveo|localhost\.run|\bfrp[cs]?\b|tailscale\s+funnel|\bssh\b[^\n]{0,40}\s-R\b|隧道|内网穿透|端口转发/i;
const TIER2 = new RegExp(`${TIER1.source}|公网|穿透|port.?forward|expos\\w*\\s+(?:(?:a|an|the|your|this|its)\\s+)?(?:local|loopback|localhost|127\\.0\\.0\\.1|ports?|services?|servers?|backends?)\\b|Allow-Private-Network`, "i");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED = new Set(["client/hermes-bundle.js", "index.client.ts", "server/assets/store-worker.txt"]);
const SELF = "server/tunnel-policy.test.ts";

const strip = (text: string) => text.split(ALLOWED).join("");
function matches(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [index, line] of strip(text).split("\n").entries()) {
    const match = line.match(pattern);
    if (match) found.push(`${index + 1}: …${line.slice(Math.max(0, (match.index ?? 0) - 60), (match.index ?? 0) + 80)}…`);
  }
  return found;
}

describe("tunnel policy", () => {
  it("keeps the one allowed prohibition sentence in the agent-facing skill text", () => {
    expect(skillMarkdown("/tmp/paseo-board")).toContain(ALLOWED);
    expect(boardInstructions("/tmp/paseo-board", "/tmp/SKILL.md")).not.toMatch(TIER1);
  });

  it("tier 1: no tracked text file mentions a public-exposure tool or technique", async () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
      .filter(file => !file.includes("node_modules/") && file !== SELF && !GENERATED.has(file) && !/\.(png|jpe?g|gif|webp|ico|zip|sqlite|woff2?)$/i.test(file));
    expect(files.length).toBeGreaterThan(100);
    const problems: string[] = [];
    for (const file of files) {
      const text = await readFile(join(root, file), "utf8").catch(() => "");
      for (const hit of matches(text, TIER1)) problems.push(`${file}:${hit}`);
    }
    expect(problems).toEqual([]);
  });

  it("tier 2: agent- and user-facing text never suggests exposing a local service", async () => {
    const texts: Array<[string, string]> = [
      ["boardInstructions", boardInstructions("/tmp/paseo-board", "/tmp/SKILL.md")],
      ["skillMarkdown", skillMarkdown("/tmp/paseo-board")],
      ["toolDefinitions", toolDefinitions().map(tool => `${tool.name}: ${tool.description}`).join("\n")],
      ["CLI usage", (RUNTIME_SOURCE.match(/Usage: paseo-board[^']*/g) ?? []).join("\n")],
      ["wake prompt", wakePrompt({ boardId: "board", expectedCreatedAt: "2026-11-13T00:00:00.000Z", interactionId: "inbox-00000000-1-1", title: "Board", inboxRevision: 1, comments: [{ commentId: "comment-1", revision: 1, visitorTag: "a1b2c3d4e5f6", canSeeReply: true }] })],
      ["assistant system prompt", assistantSystemPrompt({ id: "board", title: "Board" })],
    ];
    expect(texts[3][1]).toContain("inbox reply");
    for (const file of execFileSync("git", ["ls-files", "client"], { cwd: root, encoding: "utf8" }).split("\n").filter(name => name.endsWith(".tsx")))
      texts.push([file, await readFile(join(root, file), "utf8")]);
    for (const file of ["shared/visitor-comments.ts", "backend/visitor.mjs", "docs/page-comments.md", "docs/comment-inbox.md"])
      texts.push([file, await readFile(join(root, file), "utf8")]);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "board-tunnel-policy-")));
    try {
      await initializeApp(join(directory, "app"), "policy-check");
      for (const name of ["README.md", ".env.example"]) texts.push([`scaffold ${name}`, await readFile(join(directory, "app", name), "utf8")]);
    } finally { await rm(directory, { recursive: true, force: true }); }
    const problems = texts.flatMap(([name, text]) => matches(text, TIER2).map(hit => `${name}:${hit}`));
    expect(problems).toEqual([]);
  });

  it("detects what it is meant to detect", () => {
    for (const sample of ["run cloudflared", "ngrok http 8787", "ssh -N -R 80:localhost:8787 host", "用内网穿透", "开一个隧道", "tailscale funnel 8787", "a frpc config", "localhost.run"]) expect(sample, sample).toMatch(TIER1);
    for (const sample of ["expose your local backend", "exposes the port", "把后端暴露到公网", "Access-Control-Allow-Private-Network", "port forwarding"]) expect(sample, sample).toMatch(TIER2);
    expect(strip(`a ${ALLOWED} b`)).not.toMatch(TIER1);
  });
});
