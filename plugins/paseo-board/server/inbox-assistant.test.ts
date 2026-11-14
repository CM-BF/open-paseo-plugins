import { describe, expect, it } from "vitest";
import { assistantOptions, checkAssistantChoice, KNOWN_MODE_TIERS, modeTier, type ModeDescription } from "./inbox-assistant";
import type { Snapshot } from "./sdk";

// Captured from the installed daemon 0.16.0-beta.2 (page-comments live check 04-mode-tier-source.json):
// the owner's agent snapshot lists its modes without colorTier, the provider mode list has them.
const DAEMON_SNAPSHOT_MODES = [
  { id: "plan", label: "Plan Mode", description: "Analyze the codebase without executing tools or edits" },
  { id: "default", label: "Always Ask", description: "Prompts for permission the first time a tool is used" },
  { id: "acceptEdits", label: "Accept File Edits", description: "Automatically approves edit-focused tools without prompting" },
  { id: "auto", label: "Auto mode", description: "Uses a model classifier to review permission prompts automatically" },
  { id: "bypassPermissions", label: "Bypass", description: "Skip all permission prompts (use with caution)" },
];
const DAEMON_PROVIDER_MODES = [
  { ...DAEMON_SNAPSHOT_MODES[0], icon: "ShieldEllipsis", colorTier: "planning" },
  { ...DAEMON_SNAPSHOT_MODES[1], icon: "Shield", colorTier: "safe" },
  { ...DAEMON_SNAPSHOT_MODES[2], icon: "ShieldPlus", colorTier: "moderate" },
  { ...DAEMON_SNAPSHOT_MODES[3], icon: "ShieldCheck", colorTier: "moderate" },
  { ...DAEMON_SNAPSHOT_MODES[4], icon: "ShieldOff", colorTier: "dangerous" },
];
const CLAUDE_CHOICES = [
  { id: "plan", label: "Plan Mode", tier: "planning", selectable: false, needsRiskAcceptance: false },
  { id: "default", label: "Always Ask", tier: "safe", selectable: true, needsRiskAcceptance: false },
  { id: "acceptEdits", label: "Accept File Edits", tier: "moderate", selectable: true, needsRiskAcceptance: true },
  { id: "auto", label: "Auto mode", tier: "moderate", selectable: true, needsRiskAcceptance: true },
  { id: "bypassPermissions", label: "Bypass", tier: "dangerous", selectable: false, needsRiskAcceptance: false },
];
const owner = (availableModes: Array<{ id: string; label: string; colorTier?: string }>, provider = "claude", model: string | null = "claude-opus-5-5") =>
  ({ id: "owner", provider, model, availableModes } as unknown as Snapshot);
const SELECT_REFUSAL = "不能用这个权限模式自动处理评论；请选一个会先询问你的模式。";

describe("comment assistant permission modes (DESIGN §11.3)", () => {
  it("reads tiers from the daemon's provider mode list when the owner's snapshot modes carry none", () => {
    const options = assistantOptions(owner(DAEMON_SNAPSHOT_MODES), null, DAEMON_PROVIDER_MODES);
    expect(options).toMatchObject({ ownerMissing: false, providerSupported: true, provider: "claude/claude-opus-5-5", recommendedModeId: "default" });
    expect(options.modes).toEqual(CLAUDE_CHOICES);
    expect(checkAssistantChoice(options, "default", false)).toMatchObject({ id: "default", tier: "safe" });
    expect(() => checkAssistantChoice(options, "plan", true)).toThrow(SELECT_REFUSAL);
    expect(() => checkAssistantChoice(options, "bypassPermissions", true)).toThrow(SELECT_REFUSAL);
    expect(() => checkAssistantChoice(options, "acceptEdits", false)).toThrow("这个权限模式需要你先确认风险。");
    expect(checkAssistantChoice(options, "auto", true)).toMatchObject({ id: "auto", tier: "moderate" });
  });

  it("falls back to the vetted built-in table when the provider list is unavailable", () => {
    const options = assistantOptions(owner(DAEMON_SNAPSHOT_MODES), null, null);
    expect(options.modes).toEqual(CLAUDE_CHOICES);
    expect(options.recommendedModeId).toBe("default");
    expect(assistantOptions(owner(DAEMON_SNAPSHOT_MODES), null, []).modes).toEqual(CLAUDE_CHOICES);
    for (const [provider, modes] of KNOWN_MODE_TIERS) for (const [id, tier] of modes) expect(modeTier({ id }, provider)).toBe(tier);
  });

  it("fails closed: modes without a verified tier cannot be chosen, and nothing unknown is recommended", () => {
    const options = assistantOptions(owner([{ id: "custom", label: "Custom" }, { id: "plan_mode", label: "Plan" }, { id: "constructor", label: "Proto" }]), null, [{ id: "custom" }]);
    expect(options.modes.map(mode => [mode.id, mode.tier, mode.selectable, mode.needsRiskAcceptance])).toEqual([["custom", "unknown", false, false], ["plan_mode", "unknown", false, false], ["constructor", "unknown", false, false]]);
    expect(options.recommendedModeId).toBeNull();
    for (const id of ["custom", "plan_mode", "constructor", "missing"]) {
      expect(() => checkAssistantChoice(options, id, true)).toThrow(SELECT_REFUSAL);
    }
    // A table entry belongs to its provider only.
    expect(modeTier({ id: "default" }, "codex")).toBe("unknown");
    expect(modeTier({ id: "default" }, "claude-work")).toBe("unknown");
    expect(modeTier({ id: "default" }, "claude/sonnet")).toBe("safe");
  });

  it("lets the snapshot decide first, then the provider list; a colour that is not a tier stays unknown", () => {
    const declared: ModeDescription[] = [{ id: "default", colorTier: "moderate" }];
    expect(modeTier({ id: "default", colorTier: "dangerous" }, "claude", declared)).toBe("dangerous");
    expect(modeTier({ id: "default" }, "claude", declared)).toBe("moderate");
    expect(modeTier({ id: "default", colorTier: "" }, "claude", declared)).toBe("moderate");
    expect(modeTier({ id: "acceptEdits" }, "claude", declared)).toBe("moderate");
    // OpenCode agents may carry a hex colour: a customised agent is never matched to the built-in table.
    expect(modeTier({ id: "build", colorTier: "#ff8800" }, "opencode")).toBe("unknown");
    expect(modeTier({ id: "build" }, "opencode", [{ id: "build", colorTier: "#ff8800" }])).toBe("unknown");
    expect(modeTier({ id: "build" }, "opencode")).toBe("moderate");
    expect(modeTier({ id: "reviewer", colorTier: "#00ff00" }, "opencode")).toBe("unknown");
    // Dangerous names stay dangerous whatever a source says.
    expect(modeTier({ id: "full-access", colorTier: "safe" }, "codex", [{ id: "full-access", colorTier: "safe" }])).toBe("dangerous");
    expect(modeTier({ id: "my-yolo" }, "claude")).toBe("dangerous");
  });

  it("recommends nothing when no mode is safe (Codex) and keeps planning modes out", () => {
    const codex = assistantOptions(owner([{ id: "auto", label: "Default Permissions" }, { id: "auto-review", label: "Auto-review" }, { id: "full-access", label: "Full Access" }], "codex", "gpt-5.4"), null, null);
    expect(codex.modes.map(mode => [mode.id, mode.tier, mode.selectable, mode.needsRiskAcceptance])).toEqual([["auto", "moderate", true, true], ["auto-review", "moderate", true, true], ["full-access", "dangerous", false, false]]);
    expect(codex.recommendedModeId).toBeNull();
    const opencode = assistantOptions(owner([{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }], "opencode", null), null, null);
    expect(opencode.modes.map(mode => [mode.id, mode.tier, mode.selectable])).toEqual([["build", "moderate", true], ["plan", "planning", false]]);
    expect(() => checkAssistantChoice(opencode, "plan", true)).toThrow(SELECT_REFUSAL);
  });

  it("refuses a dialog choice whose tier is not safe or moderate even if marked selectable", () => {
    const forged = { ...assistantOptions(owner(DAEMON_SNAPSHOT_MODES), null, null) };
    forged.modes = forged.modes.map(mode => ({ ...mode, selectable: true, needsRiskAcceptance: false }));
    expect(() => checkAssistantChoice(forged, "plan", false)).toThrow(SELECT_REFUSAL);
    expect(() => checkAssistantChoice(forged, "bypassPermissions", false)).toThrow(SELECT_REFUSAL);
  });
});
