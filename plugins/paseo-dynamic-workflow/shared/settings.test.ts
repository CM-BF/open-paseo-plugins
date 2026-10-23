import { expect, it } from "vitest";
import { DEFAULT_PREFERENCES, preferences, PreferencesSchema } from "./settings";

it("migrates the former all-agent switch without opting anyone in or resetting run limits", async () => {
  const migrated = await preferences.migrate!({
    injectIntoNewAgents: true,
    preapproveTools: false,
    maxConcurrentAgents: 3,
    maxAgentsPerRun: 42,
    archiveFinishedAgents: false,
    agentTimeoutMinutes: 17,
  }, 1);
  expect(migrated).toEqual({
    ...DEFAULT_PREFERENCES,
    preapproveTools: false,
    maxConcurrentAgents: 3,
    maxAgentsPerRun: 42,
    archiveFinishedAgents: false,
    agentTimeoutMinutes: 17,
  });
});

it("keeps a stored version-2 document without workflowSize and defaults the guideline to unrestricted", () => {
  expect(preferences.version).toBe(2);
  const stored = { preapproveTools: false, maxConcurrentAgents: 3, maxAgentsPerRun: 42, archiveFinishedAgents: false, agentTimeoutMinutes: 17 };
  expect(PreferencesSchema.parse(stored)).toEqual({ ...stored, workflowSize: "unrestricted" });
  expect(PreferencesSchema.safeParse({ ...stored, workflowSize: "huge" }).success).toBe(false);
});
