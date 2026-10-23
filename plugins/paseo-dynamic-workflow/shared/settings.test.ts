import { expect, it } from "vitest";
import { DEFAULT_PREFERENCES, preferences } from "./settings";

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
