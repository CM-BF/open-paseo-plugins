import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { MCP_SERVER } from "../shared/ids";

// Background check-ins run with nobody watching. Every permission prompt they raise is answered
// here: reading and looking things up is allowed; anything that writes, sends or runs arbitrary
// code is refused with a reason the model can act on. Nothing is left pending, because a prompt
// nobody answers would stall the run until its time limit.

export type Decision = Extract<AgentPermissionResponse, { behavior: "allow" }> | Extract<AgentPermissionResponse, { behavior: "deny" }>;

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebSearch", "TodoWrite", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell", "container.exec", "run_command"]);
const NOBODY = "This is a background check-in: nobody is there to answer. Put open questions in the report instead.";
const READ_ONLY = "Background check-ins are read-only.";

/** First words of MCP tool names that only read. Anything else (send, create, query, …) is refused. */
const READ_WORDS = new Set(["get", "list", "search", "read", "fetch", "find", "lookup", "describe", "view", "show", "count", "preview", "summarize", "summarise"]);

export function decideCheckinPermission(request: AgentPermissionRequest): Decision {
  if (request.kind === "question" || request.kind === "plan" || request.kind === "mode") return deny(NOBODY);
  const name = request.name ?? "";
  if (READ_TOOLS.has(name)) return allow();
  if (name === "WebFetch") return webFetch(request);
  if (name.startsWith(`mcp__${MCP_SERVER}__`)) return allow();
  if (name.startsWith("mcp__")) {
    const tool = name.split("__").slice(2).join("__");
    return READ_WORDS.has(firstWord(tool)) ? allow() : deny(`${READ_ONLY} ${tool} looks like it changes something; report what you would do instead.`);
  }
  const command = shellCommand(request);
  if (SHELL_TOOLS.has(name) || command !== null) {
    if (command === null) return deny(`${READ_ONLY} The command could not be read.`);
    const verdict = readOnlyCommand(command);
    return verdict === true ? allow() : deny(`${READ_ONLY} ${verdict}`);
  }
  return deny(`${READ_ONLY} ${name || "This tool"} is not available to check-ins.`);
}

function allow(): Decision {
  return { behavior: "allow" };
}

function deny(message: string): Decision {
  return { behavior: "deny", message };
}

/** "getThread", "search_threads", "List-Events" → "get", "search", "list". */
export function firstWord(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.\s]+/)[0] ?? "";
}

/**
 * Pages may be read, but a check-in reads untrusted mail and issues, so a fetch must not carry
 * data out in a query string: plain http(s) URLs without query, fragment or credentials only.
 */
function webFetch(request: AgentPermissionRequest): Decision {
  const url = (request.input as Record<string, unknown> | undefined)?.url;
  if (typeof url !== "string") return deny(`${READ_ONLY} The URL could not be read.`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(`${READ_ONLY} ${url} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return deny("Only http(s) pages can be fetched.");
  if (parsed.username || parsed.password) return deny("URLs with credentials are not fetched.");
  if (parsed.search || parsed.hash || url.length > 300) return deny("Check-ins fetch plain page URLs only (no query strings); use WebSearch to find pages.");
  return allow();
}

export function shellCommand(request: AgentPermissionRequest): string | null {
  const input = request.input as Record<string, unknown> | undefined;
  const value = input?.command ?? input?.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
    // Codex sends argv; unwrap `bash -lc "<script>"`.
    const argv = value as string[];
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2]!;
    return argv.map((part) => (/^[\w./:@%+=,-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)).join(" ");
  }
  return null;
}

type Check = (args: string[]) => true | string;
const anyArgs: Check = () => true;
const without = (pattern: RegExp, reason: string): Check => (args) => (args.some((arg) => pattern.test(arg)) ? reason : true);

/** Programs that only read, with the options that would make them write or run something. */
const READERS: Record<string, Check> = {
  ls: anyArgs, cat: anyArgs, head: anyArgs, tail: anyArgs, wc: anyArgs, grep: anyArgs, egrep: anyArgs, fgrep: anyArgs,
  cal: anyArgs, pwd: anyArgs, echo: anyArgs, printf: anyArgs, whoami: anyArgs, uname: anyArgs, which: anyArgs,
  stat: anyArgs, du: anyArgs, df: anyArgs, cut: anyArgs, tr: anyArgs, jq: anyArgs, basename: anyArgs, dirname: anyArgs,
  realpath: anyArgs, readlink: anyArgs, mdfind: anyArgs, icalBuddy: anyArgs, sw_vers: anyArgs, uptime: anyArgs,
  column: anyArgs, true: anyArgs, nl: anyArgs,
  date: without(/^(-s|--set)/, "date may not set the clock."),
  rg: without(/^--pre(=|$)/, "rg --pre runs a program on every file."),
  sort: without(/^(-o|--output)/, "sort -o writes a file."),
  tree: without(/^-o$/, "tree -o writes a file."),
  file: without(/^(-C|--compile)$/, "file -C writes a file."),
  uniq: (args) => (args.filter((arg) => !arg.startsWith("-")).length > 1 ? "uniq with an output file writes it." : true),
  find: without(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/, "find with -delete, -exec or -fprint can change files."),
};

const GIT_READ = new Set(["status", "log", "show", "diff", "rev-parse", "describe", "ls-files", "shortlog", "blame", "cat-file", "for-each-ref", "reflog", "rev-list", "merge-base", "name-rev", "grep"]);
const GH_READ: Record<string, Set<string>> = {
  pr: new Set(["list", "view", "checks", "status", "diff"]),
  issue: new Set(["list", "view", "status"]),
  run: new Set(["list", "view"]),
  workflow: new Set(["list", "view"]),
  repo: new Set(["view", "list"]),
  release: new Set(["list", "view"]),
  search: new Set(["issues", "prs", "repos", "commits", "code"]),
  status: new Set([""]),
};
const PASEO_READ: Record<string, Set<string>> = {
  ls: new Set([""]),
  agent: new Set(["ls", "inspect"]),
  schedule: new Set(["ls", "inspect"]),
  daemon: new Set(["status"]),
};

/** true when the command only reads, else the reason it does not qualify. */
export function readOnlyCommand(command: string): true | string {
  // Silencing stderr is harmless and very common in model-written commands.
  const text = command.replace(/(^|\s)2>\s*\/dev\/null(?=\s|$)/g, " ").replace(/(^|\s)2>&1(?=\s|$)/g, " ").trim();
  if (!text) return "Empty command.";
  if (/`|\$\(|\$\{|<\(|>\(/.test(text)) return "Command substitution is not allowed.";
  const segments = splitPipeline(text);
  if (typeof segments === "string") return segments;
  for (const segment of segments) {
    const verdict = readOnlySegment(segment);
    if (verdict !== true) return verdict;
  }
  return true;
}

/** Splits on unquoted pipes; any other control operator or redirection is refused. */
function splitPipeline(text: string): string[][] | string {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  const flush = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      word += text[++index];
      hasWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "|") {
      if (text[index + 1] === "|") return "Chained commands are not allowed (no ||).";
      flush();
      if (words.length === 0) return "Empty pipeline segment.";
      segments.push(words);
      words = [];
      continue;
    }
    if (char === ";" || char === "&" || char === ">" || char === "<") return "Chained commands and redirections are not allowed; run one read-only command.";
    word += char;
    hasWord = true;
  }
  if (quote) return "Unbalanced quotes.";
  flush();
  if (words.length === 0) return "Empty pipeline segment.";
  segments.push(words);
  return segments;
}

function readOnlySegment(words: string[]): true | string {
  // VAR=value prefixes can point pagers and helpers at arbitrary programs (GIT_PAGER, LESSOPEN).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) return "Environment assignments are not allowed.";
  const program = (words[0] ?? "").replace(/^.*\//, "");
  const args = words.slice(1);
  if (!program) return "Empty command.";
  const reader = READERS[program];
  if (reader) return reader(args);
  if (program === "git") return gitReadOnly(args);
  if (program === "gh") return ghReadOnly(args);
  if (program === "paseo") return subcommandReadOnly("paseo", args, PASEO_READ);
  return `${program} is not on the read-only list (ls, cat, grep, find, git log/status/diff, gh pr/issue/run list/view, …).`;
}

function gitReadOnly(args: string[]): true | string {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    const option = args[index]!;
    // -c can set core.pager or core.fsmonitor to any program.
    if (option === "-c" || option.startsWith("--config-env") || option.startsWith("--exec-path")) return "git -c and --exec-path are not allowed.";
    index += option === "-C" ? 2 : 1;
  }
  const subcommand = args[index] ?? "";
  const rest = args.slice(index + 1);
  if (rest.some((arg) => /^--output(=|$)/.test(arg))) return "git --output writes a file.";
  if (subcommand === "grep" && rest.some((arg) => /^(-O|--open-files-in-pager)/.test(arg))) return "git grep -O runs a program.";
  if (GIT_READ.has(subcommand)) return true;
  if (subcommand === "branch") {
    const modifies = rest.some((arg) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(arg));
    // `git branch <name>` creates a branch; a bare word is a pattern only with --list.
    const named = rest.some((arg) => !arg.startsWith("-")) && !rest.some((arg) => arg === "--list" || arg === "-l");
    return modifies || named ? "Only listing branches is allowed." : true;
  }
  if (subcommand === "remote") return rest.length === 0 || rest.every((arg) => arg === "-v" || arg === "--verbose") || rest[0] === "show" || rest[0] === "get-url" ? true : "Only listing remotes is allowed.";
  if (subcommand === "tag") {
    if (rest.length === 0) return true;
    const listing = rest.includes("-l") || rest.includes("--list");
    const flags = rest.every((arg) => !arg.startsWith("-") || /^(-l|--list|-n\d*|--sort=.+|--contains|--no-contains|--points-at|--merged|--no-merged|--format=.+)$/.test(arg));
    return listing && flags ? true : "Only listing tags (git tag -l) is allowed.";
  }
  if (subcommand === "stash") return rest[0] === "list" || rest[0] === "show" ? true : "Only listing stashes is allowed.";
  return `git ${subcommand || "(no subcommand)"} is not read-only.`;
}

function ghReadOnly(args: string[]): true | string {
  if (args.some((arg) => arg === "--web" || arg === "-w")) return "gh --web opens a browser.";
  const [group = "", action = ""] = args;
  if (group === "api") {
    for (let index = 1; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "-X" || arg === "--method") {
        if ((args[index + 1] ?? "").toUpperCase() !== "GET") return "gh api may only GET.";
        index++;
      } else if (/^(-X|--method=)/.test(arg)) {
        if (arg.replace(/^(-X|--method=)/, "").toUpperCase() !== "GET") return "gh api may only GET.";
      } else if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg)) {
        return "gh api with fields or input sends a request body.";
      }
    }
    return true;
  }
  const allowed = GH_READ[group];
  if (!allowed) return `gh ${group} is not read-only.`;
  if (allowed.has("")) return true;
  return allowed.has(action) ? true : `gh ${group} ${action} is not read-only.`;
}

function subcommandReadOnly(program: string, args: string[], table: Record<string, Set<string>>): true | string {
  const words = args.filter((arg) => !arg.startsWith("-"));
  const [group = "", action = ""] = words;
  const allowed = table[group];
  if (!allowed) return `${program} ${group} is not read-only.`;
  if (allowed.has("")) return true;
  return allowed.has(action) ? true : `${program} ${group} ${action} is not read-only.`;
}
