import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AlertSchema, ConfigSchema, FollowupSchema, OverviewSchema } from "./types";

export const overviewRpc = defineRpc({
  name: "aide.overview",
  input: z.object({}),
  output: OverviewSchema,
});

export const setupRpc = defineRpc({
  name: "aide.setup",
  input: z.object({
    name: z.string().trim().min(1).max(40),
    language: z.string().trim().max(40),
    home: z.string().trim().min(1),
    chatModel: z.string().min(1),
    chatMode: z.string(),
    checkinModel: z.string().min(1),
    /** Seed for WATCHLIST.md; kept when the file already exists. */
    watchlist: z.string().max(20_000).optional(),
  }),
  output: z.object({ agentId: z.string(), workspaceId: z.string().nullable(), home: z.string() }),
});

export const saveConfigRpc = defineRpc({
  name: "aide.config.save",
  input: z.object({ config: ConfigSchema }),
  output: z.object({ config: ConfigSchema }),
});

export const checkNowRpc = defineRpc({
  name: "aide.checkin.now",
  input: z.object({ focus: z.string().max(2000).optional() }),
  output: z.object({ started: z.boolean(), message: z.string() }),
});

export const briefNowRpc = defineRpc({
  name: "aide.brief.now",
  input: z.object({}),
  output: z.object({ queued: z.boolean(), message: z.string() }),
});

export const AlertActionSchema = z.enum(["done", "snooze", "mute", "reopen"]);
export const updateAlertRpc = defineRpc({
  name: "aide.alert.update",
  input: z.object({
    id: z.string(),
    action: AlertActionSchema,
    /** For snooze: a "when" expression such as "in 3h" or "tomorrow 9am". */
    until: z.string().optional(),
  }),
  output: z.object({ alert: AlertSchema, message: z.string() }),
});

export const createFollowupRpc = defineRpc({
  name: "aide.followup.create",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(4000),
    when: z.string().max(200),
    repeat: z.string().max(200).optional(),
    until: z.string().max(200).optional(),
    mode: z.enum(["remind", "check"]),
  }),
  output: z.object({ followup: FollowupSchema, receipt: z.string() }),
});

export const cancelFollowupRpc = defineRpc({
  name: "aide.followup.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ followup: FollowupSchema }),
});

export const HomeFileSchema = z.enum(["WATCHLIST.md", "MEMORY.md"]);
export const readFileRpc = defineRpc({
  name: "aide.file.read",
  input: z.object({ name: HomeFileSchema }),
  output: z.object({ path: z.string(), text: z.string(), exists: z.boolean() }),
});

export const writeFileRpc = defineRpc({
  name: "aide.file.write",
  input: z.object({ name: HomeFileSchema, text: z.string().max(100_000) }),
  output: z.object({ path: z.string() }),
});

export const pauseRpc = defineRpc({
  name: "aide.pause",
  input: z.object({
    /** "always", a "when" expression ("tomorrow 8am"), or null to resume. */
    until: z.string().max(200).nullable(),
  }),
  output: z.object({ pausedUntil: z.string().nullable(), message: z.string() }),
});

export const ModelOptionSchema = z.object({ value: z.string(), label: z.string() });
export const modelsRpc = defineRpc({
  name: "aide.models",
  input: z.object({}),
  output: z.object({
    models: z.array(ModelOptionSchema),
    modes: z.record(z.string(), z.array(ModelOptionSchema)),
    defaultHome: z.string(),
    timezone: z.string(),
  }),
});
