import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LABEL_ROLE } from "../shared/ids";
import { decodeUpdate } from "../shared/update";
import type { PaseoApi } from "./access";
import type { Report } from "./alerts";
import { statePaths } from "./paths";
import { AideService } from "./service";

// Friday 23 October 2026, 10:00 in Los Angeles.
const START = Date.parse("2026-10-23T17:00:00Z");
const TZ = "America/Los_Angeles";

interface FakeAgent {
  id: string;
  cwd: string;
  parent: string | null;
  labels: Record<string, string>;
  config: Record<string, unknown>;
  prompt: string | null;
  sent: string[];
  timeline: AgentTimelineItem[];
  status: "idle" | "running";
  archivedAt: string | null;
  lastMessage: string | null;
  requiresAttention: boolean;
}

/** Just enough of the Paseo SDK for the service: agents, a workspace, and the agent directory. */
class FakePaseo {
  agents = new Map<string, FakeAgent>();
  onChildCreated: ((agent: FakeAgent) => void) | null = null;
  /** Child creations that fail the way a slow before-hook of another plugin does. */
  failChildCreates = 0;

  api(): PaseoApi {
    const create = async (options: Record<string, any>) => {
      if (options.parent && this.failChildCreates > 0) {
        this.failChildCreates--;
        throw new Error("Plugin next-workspace before agent.create failed: Plugin RPC timed out: next-workspace.hook");
      }
      const agent: FakeAgent = {
        id: options.agentId,
        cwd: options.cwd,
        parent: typeof options.parent === "string" ? options.parent : null,
        labels: options.labels ?? {},
        config: options.config,
        prompt: options.prompt ?? null,
        sent: [],
        timeline: options.prompt ? [{ type: "user_message", text: options.prompt }] : [],
        status: "idle",
        archivedAt: null,
        lastMessage: null,
        requiresAttention: false,
      };
      this.agents.set(agent.id, agent);
      if (agent.parent) this.onChildCreated?.(agent);
      return this.handle(agent.id);
    };
    return {
      agents: {
        create,
        ref: (id: string) => this.handle(id),
        list: async () => ({ entries: [], pageInfo: {} }),
      },
      workspaces: {
        open: async (cwd: string) => ({ id: "wks_test", agents: { create: (options: Record<string, unknown>) => create({ ...options, cwd }) } }),
      },
    } as unknown as PaseoApi;
  }

  private snapshot(agent: FakeAgent) {
    return { id: agent.id, status: agent.status, archivedAt: agent.archivedAt, activeTurn: null, pendingPermissions: [], workspaceId: "wks_test", lastError: undefined, requiresAttention: agent.requiresAttention };
  }

  private handle(id: string) {
    const agent = () => {
      const found = this.agents.get(id);
      if (!found) throw new Error(`unknown agent ${id}`);
      return found;
    };
    return {
      id,
      workspaceId: "wks_test",
      refresh: async () => ({ agent: this.snapshot(agent()) }),
      send: async (text: string) => {
        agent().sent.push(text);
        agent().timeline.push({ type: "user_message", text });
      },
      waitForFinish: async () => ({ status: "idle", final: this.snapshot(agent()), error: null, lastMessage: agent().lastMessage }),
      respondToPermission: async () => undefined,
      archive: async () => {
        agent().archivedAt = new Date().toISOString();
        return { archivedAt: agent().archivedAt };
      },
      timeline: { refetch: async () => ({ entries: agent().timeline.map((item) => ({ item })) }) },
      current: () => this.snapshot(agent()),
    };
  }
}

let dir: string;
let clock: number;
let fake: FakePaseo;
let service: AideService;

const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
const settle = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
  await (service as unknown as { running: Promise<void> | null }).running;
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
};
const assistant = () => [...fake.agents.values()].find((agent) => agent.labels[LABEL_ROLE] === "assistant")!;
const children = () => [...fake.agents.values()].filter((agent) => agent.labels[LABEL_ROLE] === "checkin");

function reportWith(report: Report) {
  fake.onChildCreated = (child) => {
    const runId = child.labels["paseo-aide/run"]!;
    service.recordReport({ role: "checkin", agentId: child.id, runId }, report);
    child.lastMessage = "Reported.";
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-aide-test-"));
  clock = START;
  fake = new FakePaseo();
  // Check-ins that come due while a test looks at something else find nothing.
  fake.onChildCreated = (child) => {
    child.lastMessage = "{\"notify\": false, \"summary\": \"quiet\"}";
  };
  service = new AideService({ paths: statePaths(join(dir, "state")), paseoHome: join(dir, "paseo-home"), now: () => clock, createRetryDelaysMs: [1, 1] });
  await service.start();
  service.access.capture(fake.api());
  service.saveConfig({ ...service.config(), timezone: TZ });
  await service.setup({ name: "Aide", language: "", home: join(dir, "Aide"), chatModel: "claude/claude-sonnet-5-5", chatMode: "auto", checkinModel: "claude/claude-haiku-4-5" }, fake.api());
});

afterEach(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("setup", () => {
  it("creates the assistant with its tools, instructions, folder and a welcome", async () => {
    const chat = assistant();
    expect(chat.config).toMatchObject({ provider: "claude/claude-sonnet-5-5", modeId: "auto" });
    expect(chat.config.systemPrompt).toMatch(/You are Aide, the user's personal agent/);
    expect((chat.config.mcpServers as Record<string, { url: string }>).aide.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/assistant\//);
    expect(decodeUpdate(chat.prompt!)?.kind).toBe("welcome");
    expect(await readFile(join(dir, "Aide", "WATCHLIST.md"), "utf8")).toMatch(/Watch list/);
    await expect(service.setup({ name: "Again", language: "", home: join(dir, "Aide"), chatModel: "claude/x", chatMode: "", checkinModel: "claude/y" }, fake.api())).rejects.toThrow(/already set up/);
  });
});

describe("check-ins", () => {
  it("waits after setup, then runs a silent child that only speaks up with news", async () => {
    await tick();
    expect(children()).toHaveLength(0);

    clock += 11 * 60_000;
    reportWith({ notify: true, summary: "CI is red.", items: [{ key: "gh:o/r#41:ci", title: "CI failed on PR #41", detail: "3 timeouts", urgency: "normal" }] });
    await tick();
    await settle();
    const [child] = children();
    expect(child).toMatchObject({ parent: assistant().id, cwd: join(dir, "Aide") });
    expect(child!.config).toMatchObject({ provider: "claude/claude-haiku-4-5", modeId: "default" });
    expect(child!.prompt).toMatch(/Check-in for Aide/);
    expect(child!.archivedAt).not.toBeNull();

    // The finding reaches the chat as a note the assistant turns into a message.
    await tick();
    await settle();
    const note = decodeUpdate(assistant().sent.at(-1)!);
    expect(note).toMatchObject({ kind: "checkin", items: [{ title: "CI failed on PR #41" }] });
    const state = service.store.state;
    expect(state.alerts[0]).toMatchObject({ status: "open", delivered: true });
    expect(state).toMatchObject({ messagesToday: 1, unanswered: 1, quietStreak: 0 });

    // The same finding again is not news.
    clock += 2 * 60 * 60_000;
    await tick();
    await settle();
    expect(children()).toHaveLength(2);
    expect(assistant().sent.filter((text) => decodeUpdate(text)?.kind === "checkin")).toHaveLength(1);
    expect(service.store.state.quietStreak).toBe(1);
  });

  it("clears the chat's unread mark first, so the phone is notified again", async () => {
    const cleared: string[] = [];
    service.access.clearAttention = async (agentId: string) => {
      cleared.push(agentId);
      fake.agents.get(agentId)!.requiresAttention = false;
    };
    assistant().requiresAttention = true; // the welcome was never opened
    clock += 11 * 60_000;
    reportWith({ notify: true, summary: "x", items: [{ key: "k", title: "Ana replied", detail: "", urgency: "normal" }] });
    await tick();
    await settle();
    await tick();
    await settle();
    expect(cleared).toEqual([assistant().id]);
    expect(assistant().sent.some((text) => decodeUpdate(text)?.kind === "checkin")).toBe(true);
  });

  it("holds ordinary news while proactive messages go unanswered, and resets when the user writes", async () => {
    service.saveConfig({ ...service.config(), unansweredLimit: 1 });
    service.store.state.unanswered = 1;
    clock += 11 * 60_000;
    reportWith({ notify: true, summary: "Reply arrived.", items: [{ key: "mail:1", title: "Ana replied", detail: "", urgency: "normal" }] });
    await tick();
    await settle();
    await tick();
    await settle();
    expect(assistant().sent.some((text) => decodeUpdate(text)?.kind === "checkin")).toBe(false);
    expect(service.store.state.alerts[0]).toMatchObject({ status: "open", delivered: false });
    expect(service.activity.recent(5)[0]?.outcome).toBe("held");

    service.onTurnEnded(assistant().id, [{ type: "user_message", text: "thanks, what's next?" }]);
    expect(service.store.state.unanswered).toBe(0);
    service.onTurnEnded(assistant().id, [{ type: "user_message", text: "<!-- aide:{} -->\nnote" }]);
    expect(service.store.state.unanswered).toBe(0);
  });

  it("retries starting the agent when another plugin's hook times out", async () => {
    fake.failChildCreates = 2;
    clock += 11 * 60_000;
    reportWith({ notify: false, summary: "Quiet.", items: [] });
    await tick();
    await settle();
    expect(children()).toHaveLength(1);
    expect(service.activity.recent(1)[0]).toMatchObject({ kind: "checkin", outcome: "quiet" });
  });

  it("tries a failed scheduled check-in again soon, without using up the day", async () => {
    fake.failChildCreates = 3;
    clock += 11 * 60_000;
    await tick();
    await settle();
    expect(service.activity.recent(1)[0]).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/Trying again in 15 minutes/) });
    expect(service.store.state.checkinsToday).toBe(0);
    clock += 14 * 60_000;
    await tick();
    await settle();
    expect(service.activity.recent(1)[0]?.outcome).toBe("failed");
    clock += 2 * 60_000;
    await tick();
    await settle();
    expect(service.activity.recent(1)[0]).toMatchObject({ outcome: "quiet" });
  });

  it("records a failed check-in without a report", async () => {
    clock += 11 * 60_000;
    fake.onChildCreated = (child) => {
      child.lastMessage = "I could not finish.";
    };
    await tick();
    await settle();
    expect(service.activity.recent(1)[0]).toMatchObject({ kind: "checkin", outcome: "failed" });
    expect(service.store.state.inFlight).toBeNull();
  });

  it("accepts a JSON report in the final message when the tool was not called", async () => {
    clock += 11 * 60_000;
    fake.onChildCreated = (child) => {
      child.lastMessage = "```json\n{\"notify\": false, \"summary\": \"All quiet.\"}\n```";
    };
    await tick();
    await settle();
    expect(service.activity.recent(1)[0]).toMatchObject({ outcome: "quiet", detail: "All quiet." });
  });
});

describe("follow-ups and the brief", () => {
  it("fires a reminder at its time and moves a repeat forward", async () => {
    const { followup, receipt } = service.createFollowup({ title: "Send the Acme invoice", prompt: "Ask whether it went out.", when: "today 16:00", repeat: "weekdays 16:00", mode: "remind" }, "assistant");
    expect(receipt).toMatch(/today 16:00 \(America\/Los_Angeles\), then weekdays at 16:00/);
    clock = Date.parse("2026-10-23T23:00:30Z");
    await tick();
    await settle();
    const reminder = assistant().sent.map((text) => decodeUpdate(text)).find((update) => update?.kind === "reminder");
    expect(reminder).toMatchObject({ title: "Send the Acme invoice", followupId: followup.id });
    // Friday 16:00 → Monday 16:00.
    expect(service.store.state.followups[0]).toMatchObject({ status: "active", fired: 1, dueAt: "2026-10-26T23:00:00.000Z" });
  });

  it("refuses times that passed and repeats that are too frequent", () => {
    expect(() => service.createFollowup({ title: "x", prompt: "y", when: "2026-10-01 09:00", mode: "remind" }, "user")).toThrow(/already passed/);
    expect(() => service.createFollowup({ title: "x", prompt: "y", when: "in 1h", repeat: "every 10m", mode: "check" }, "user")).toThrow(/30 minutes/);
  });

  it("sends the morning brief once, at its time", async () => {
    clock = Date.parse("2026-10-24T15:30:00Z"); // Saturday 08:30
    await tick();
    await settle();
    const briefs = () => assistant().sent.filter((text) => decodeUpdate(text)?.kind === "brief");
    expect(briefs()).toHaveLength(1);
    expect(briefs()[0]).toMatch(/Write the user's morning brief now/);
    clock += 60_000;
    await tick();
    await settle();
    expect(briefs()).toHaveLength(1);
  });

  it("snoozes an alert and brings it back when the snooze ends", async () => {
    clock += 11 * 60_000;
    reportWith({ notify: false, summary: "FYI.", items: [{ key: "k1", title: "Package delayed", detail: "", urgency: "low" }] });
    await tick();
    await settle();
    const alert = service.store.state.alerts[0]!;
    service.updateAlert(alert.id, "snooze", "in 1h");
    expect(service.store.state.alerts[0]).toMatchObject({ status: "snoozed" });
    clock += 61 * 60_000;
    await tick();
    await settle();
    await tick();
    await settle();
    expect(service.store.state.alerts[0]).toMatchObject({ status: "open", delivered: true });
    expect(assistant().sent.some((text) => /Package delayed/.test(text))).toBe(true);
  });
});

describe("MCP relay", () => {
  async function call(url: string, token: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  }

  it("serves the assistant's tools behind its token", async () => {
    const server = (assistant().config.mcpServers as Record<string, { url: string; headers: Record<string, string> }>).aide;
    const token = server.headers.Authorization!.replace("Bearer ", "");
    const listed = await call(server.url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toContain("aide_followup_create");
    expect(names).not.toContain("aide_checkin_report");
    const created = await call(server.url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aide_followup_create", arguments: { title: "Dentist", prompt: "Remind about the dentist", when: "tomorrow 9am" } } });
    expect(JSON.stringify(created.body)).toMatch(/Scheduled \\"Dentist\\" \(reminder\) for tomorrow 09:00/);
    expect((await call(server.url, "wrong", { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(401);
  });

  it("closes a check-in's tools when its run ends", async () => {
    let checkinServer: { url: string; headers: Record<string, string> } | null = null;
    clock += 11 * 60_000;
    fake.onChildCreated = (child) => {
      checkinServer = (child.config.mcpServers as Record<string, { url: string; headers: Record<string, string> }>).aide;
      child.lastMessage = "{\"notify\": false, \"summary\": \"quiet\"}";
    };
    await tick();
    await settle();
    const server = checkinServer!;
    const ended = await call(server.url, server.headers.Authorization!.replace("Bearer ", ""), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(ended.status).toBe(403);
  });
});
