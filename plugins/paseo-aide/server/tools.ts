import { z } from "zod";
import { isClock, formatLocal } from "../shared/time";
import { describeRepeat } from "../shared/when";
import { ReportSchema } from "./alerts";
import { defineTool, type McpTool } from "./mcp";
import { waitingLines } from "./prompts";
import type { AideService } from "./service";

const Clock = z.string().refine(isClock, "Use HH:MM");

/** The plugin's MCP tools, for the assistant chat and for background check-ins. */
export function buildTools(service: AideService): McpTool[] {
  const timezone = () => service.timezone();
  return [
    defineTool({
      name: "aide_followup_create",
      roles: ["assistant"],
      alwaysLoad: true,
      description:
        "Schedule a follow-up for yourself. mode \"remind\" messages the user at that time; mode \"check\" looks in the background at that time (read-only, cheap model) and only speaks up if something needs the user. Use it whenever you promise to come back to something, and tell the user the time from the receipt. when: \"in 2h\", \"tomorrow 9am\", \"fri 16:00\", \"2026-10-24 09:30\" or ISO 8601; repeat (optional): \"every 3h\", \"daily 09:00\", \"weekdays 8:30\", \"every monday 9am\"; until (optional): when to stop repeating.",
      input: z.object({
        title: z.string().min(1).max(200).describe("Short label the user will recognise."),
        prompt: z.string().min(1).max(4000).describe("What to do or check at that time, with the details you will need then (names, links, what counts as done)."),
        when: z.string().max(200).optional().describe("First time, in the user's time zone unless it carries an offset. Optional with a daily/weekly repeat."),
        repeat: z.string().max(200).optional(),
        until: z.string().max(200).optional(),
        mode: z.enum(["remind", "check"]).default("remind"),
      }),
      run: (args) => service.createFollowup(args, "assistant").receipt,
    }),
    defineTool({
      name: "aide_followup_list",
      roles: ["assistant"],
      description: "List your scheduled follow-ups with their ids and next times.",
      input: z.object({}),
      run: () => {
        const followups = service.activeFollowups();
        if (followups.length === 0) return "No follow-ups scheduled.";
        const now = Date.now();
        return followups.map((followup) => `${followup.id}: ${followup.title} (${followup.mode}, next ${formatLocal(Date.parse(followup.dueAt), timezone(), now)}, ${describeRepeat(followup.repeat)})`).join("\n");
      },
    }),
    defineTool({
      name: "aide_followup_cancel",
      roles: ["assistant"],
      description: "Cancel a scheduled follow-up by id.",
      input: z.object({ id: z.string() }),
      run: (args) => `Canceled "${service.cancelFollowup(args.id).title}".`,
    }),
    defineTool({
      name: "aide_alerts",
      roles: ["assistant", "checkin"],
      description: "List the alerts the background check-ins raised that are open or snoozed (with ids, keys and status). include_closed also lists done and muted ones.",
      input: z.object({ include_closed: z.boolean().default(false) }),
      run: (args) => {
        const alerts = service.alerts(args.include_closed);
        if (alerts.length === 0) return "No alerts.";
        const now = Date.now();
        return alerts
          .map((alert) => {
            const status = alert.status === "snoozed" && alert.snoozedUntil ? `snoozed until ${formatLocal(Date.parse(alert.snoozedUntil), timezone(), now)}` : alert.status;
            return `${alert.id} [${status}, ${alert.urgency}] ${alert.title}${alert.detail ? ` — ${alert.detail}` : ""} (key ${alert.key})`;
          })
          .join("\n");
      },
    }),
    defineTool({
      name: "aide_alert_update",
      roles: ["assistant"],
      alwaysLoad: true,
      description: "Record the user's answer to an alert: done (handled), snooze (bring it back later; until like \"in 3h\" or \"tomorrow 9am\", default 3h), mute (never bring this up again) or reopen.",
      input: z.object({
        id: z.string().describe("Alert id (al_…) or key."),
        action: z.enum(["done", "snooze", "mute", "reopen"]),
        until: z.string().max(200).optional(),
      }),
      run: (args) => service.updateAlert(args.id, args.action, args.until).message,
    }),
    defineTool({
      name: "aide_paseo_waiting",
      roles: ["assistant", "checkin"],
      description: "The user's other Paseo agents that are waiting on them: approvals, failures and finished work nobody has looked at.",
      input: z.object({}),
      run: async () => waitingLines(await service.waiting(), timezone(), Date.now()),
    }),
    defineTool({
      name: "aide_status",
      roles: ["assistant"],
      description: "Your schedule: when the next background check-in, brief and follow-ups happen, today's counts, and whether you are paused.",
      input: z.object({}),
      run: () => service.statusText(),
    }),
    defineTool({
      name: "aide_schedule_update",
      roles: ["assistant"],
      description:
        "Change your schedule when the user asks: check-in interval and on/off, brief time and on/off, active hours, daily limit of proactive messages, or pause (\"always\", or until a time like \"tomorrow 8am\"; \"off\" resumes). Reminders the user asked for still fire while paused.",
      input: z.object({
        checkin_every_minutes: z.number().int().min(30).max(720).optional(),
        checkins_enabled: z.boolean().optional(),
        brief_time: Clock.optional(),
        brief_enabled: z.boolean().optional(),
        active_start: Clock.optional(),
        active_end: Clock.optional(),
        messages_per_day: z.number().int().min(0).max(50).optional(),
        pause: z.string().max(200).optional(),
      }),
      run: (args) => {
        const messages: string[] = [];
        const changes = {
          ...(args.checkin_every_minutes !== undefined ? { checkinEveryMinutes: args.checkin_every_minutes } : {}),
          ...(args.checkins_enabled !== undefined ? { checkinsEnabled: args.checkins_enabled } : {}),
          ...(args.brief_time !== undefined ? { briefTime: args.brief_time } : {}),
          ...(args.brief_enabled !== undefined ? { briefEnabled: args.brief_enabled } : {}),
          ...(args.active_start !== undefined || args.active_end !== undefined
            ? { activeHours: { start: args.active_start ?? service.config().activeHours.start, end: args.active_end ?? service.config().activeHours.end } }
            : {}),
          ...(args.messages_per_day !== undefined ? { messagesPerDay: args.messages_per_day } : {}),
        };
        if (Object.keys(changes).length > 0) messages.push(service.updateSchedule(changes));
        if (args.pause !== undefined) messages.push(service.pause(args.pause.trim().toLowerCase() === "off" ? null : args.pause).message);
        return messages.length > 0 ? messages.join("\n") : "Nothing to change.";
      },
    }),
    defineTool({
      name: "aide_checkin_report",
      roles: ["checkin"],
      alwaysLoad: true,
      description: "Report the result of this background check-in. Call exactly once, at the end. notify=true only for news the user should get now; otherwise notify=false (items are kept for the morning brief).",
      input: ReportSchema,
      run: (args, caller) => service.recordReport(caller, args),
    }),
  ];
}
