Dynamic workflows let any Paseo agent orchestrate other Paseo agents with a short JavaScript script, the way Claude Code's `Workflow` tool does. The agent writes a script that calls `agent()`, `parallel()` and `pipeline()`; the plugin runs it in the background, starts a real Paseo agent for every `agent()` call, and hands the script's result back to the agent as a message when the run ends. Typical uses are reviews that verify every finding with independent skeptics, research that fans out over many sources, and migrations or fixes that run one agent per file in its own git worktree.

## How it works

Workflow tools are off by default for each agent. Open `/dynamic-workflows` in the conversation and enable its switch. Enabled Claude and Codex agents get four MCP tools (`workflow`, `workflow_status`, `workflow_stop`, `workflow_reference`); disabled agents receive an empty tool list and new agents receive no workflow system prompt. Reload the agent to refresh its tool list if needed. OpenCode, Pi, OMP and older agents without an MCP binding use the reference command shown in the panel after enabling. Include it in your next prompt. Agents launch a workflow only when you ask for one in your own words, such as "use a workflow".

Each `agent()` call creates a Paseo agent that is a subagent of the launching agent. By default it uses the launcher's provider, model, mode and thinking setting. A script can pick another model, another provider, an effort level, one of your agent profiles (`agentType`), or an isolated git worktree. With a JSON Schema, the plugin checks the agent's answer and asks it to correct a mismatch. Children appear in the Subagents track while they run, so you can watch them and answer their permission prompts. They are archived once their result is recorded.

## What you see

- A run card in the launching agent's chat shows phases with progress bars, the agents that are running, the latest log line, the result, and Stop and Details buttons.
- The Dynamic workflows panel (Details, `/dynamic-workflows`, or Dynamic workflow tools and runs in the Command Center) controls access for that agent and lists its runs. For each run it shows every agent with its status, time, tokens, result or error, and transcript. From there you can skip a running agent or stop the run.
- When a run ends, a one-line row replaces the notification message, and the agent reads the full result.

## Resume and saved workflows

Every run keeps its script and a journal of each agent's result under `~/.paseo/paseo-dynamic-workflow/runs/`. An agent can edit the script and relaunch with `resumeFromRunId`. Calls whose prompt and options did not change return their saved results at once. Saved workflows are read from `.paseo/workflows/<name>.js` or `.claude/workflows/<name>.js` in the project, and from `~/.paseo/workflows/` and `~/.claude/workflows/`.

## Settings

Under Settings, Plugins, Dynamic workflows:

- Preapprove workflow tools for enabled agents so they run without a permission prompt. Access is controlled in each agent's panel, not globally.
- Concurrent agents per run. The default is min(8, CPUs minus 2), and the maximum is 16.
- Agents per run, at most 1000.
- An optional time limit per agent.
- Whether to archive finished children.

## Requirements and limits

- Paseo 0.12 or later on the daemon and the app.
- Agents created after installation get an empty MCP endpoint; enabling controls whether it publishes tools. Older agents without an endpoint can use the CLI route. An old running MCP process needs Reload to load the updated shim. Previously injected instructions and conversation history remain in old agents.
- Disabling immediately prevents new workflow launches. Existing runs continue and can still be viewed or stopped; their result notifications still arrive. Workflow children do not inherit access.
- Scripts run in a separate thread without file, network or Node.js access. This sandbox prevents mistakes; it is not a security boundary. The plugin's daemon code runs with your user's permissions, like every plugin.
- Workflows can start many agents and spend many tokens. Each child is billed by its provider as usual.
- Token counts come from what each provider reports. Codex and Pi report less than they use, so `budget` limits are approximate for them.
- Runs that are active when the plugin reloads or the daemon restarts end as interrupted. Their running children are archived, and the run can be resumed.
