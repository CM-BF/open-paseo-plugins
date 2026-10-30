import { record, throwIpcError } from './errors';
import type { Paseo } from './runtime';
import type { NativeSchedule, ScheduleDriver } from './schedules';

// Structural compatibility with the public schedules namespace added after 0.13.2.
// No private DaemonClient import or protocol transport is used on older hosts.
interface ScheduleActions {
  create(input: Record<string, unknown>): Promise<unknown>;
  list(): Promise<unknown>;
  inspect(input: { id: string }): Promise<unknown>;
  logs(input: { id: string }): Promise<unknown>;
  update(input: Record<string, unknown>): Promise<unknown>;
  pause(input: { id: string }): Promise<unknown>;
  resume(input: { id: string }): Promise<unknown>;
  delete(input: { id: string }): Promise<unknown>;
  runOnce(input: { id: string }): Promise<unknown>;
}
function payload(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.error) throwIpcError('SCHEDULE_FAILED', String(result.error));
  return result;
}
function schedule(value: unknown): NativeSchedule {
  const result = record(value);
  if (typeof result.id !== 'string') throwIpcError('INVALID_HOST_RESPONSE', 'The host did not return a schedule ID');
  return result as NativeSchedule;
}
export function scheduleCadence(input: Parameters<ScheduleDriver['create']>[0]['cadence']) {
  if (input.cron) return { type: 'cron', expression: input.cron, timezone: input.timezone ?? 'UTC' };
  const minutes = (input.everyMs ?? 0) / 60_000;
  let expression: string | undefined;
  if (Number.isInteger(minutes) && minutes > 0 && minutes < 60 && 60 % minutes === 0) expression = `*/${minutes} * * * *`;
  if (minutes === 60) expression = '0 * * * *';
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours > 1 && hours < 24 && 24 % hours === 0) expression = `0 */${hours} * * *`;
  if (hours === 24) expression = '0 0 * * *';
  if (!expression) throwIpcError('UNSUPPORTED_TRIGGER', 'The host supports whole-minute intervals that divide one hour or one day');
  return { type: 'cron', expression, timezone: 'UTC' };
}
export class ScheduleSdk implements ScheduleDriver {
  constructor(private readonly actions: ScheduleActions) {}
  static from(paseo?: Paseo): ScheduleSdk | null {
    const actions = (paseo as unknown as { schedules?: ScheduleActions } | undefined)?.schedules;
    return actions && ['create', 'list', 'inspect', 'logs', 'update', 'pause', 'resume', 'delete', 'runOnce'].every(key => typeof actions[key as keyof ScheduleActions] === 'function') ? new ScheduleSdk(actions) : null;
  }
  async list() {
    const result = payload(await this.actions.list());
    if (!Array.isArray(result.schedules)) throwIpcError('INVALID_HOST_RESPONSE', 'The host did not return schedules');
    return result.schedules.map(schedule);
  }
  async inspect(id: string) {
    const [inspected, logged] = await Promise.all([this.actions.inspect({ id }), this.actions.logs({ id })]);
    const result = schedule(payload(inspected).schedule); const logs = payload(logged);
    if (!Array.isArray(logs.runs)) throwIpcError('INVALID_HOST_RESPONSE', 'The host did not return schedule runs');
    return { ...result, runs: logs.runs as Array<Record<string, unknown>> };
  }
  async create(input: Parameters<ScheduleDriver['create']>[0]) {
    const separator = input.provider.indexOf('/');
    const provider = separator < 0 ? input.provider : input.provider.slice(0, separator);
    const model = separator < 0 ? undefined : input.provider.slice(separator + 1);
    const config = { ...input.config, provider, model, cwd: input.cwd, modeId: input.mode,
      thinkingOptionId: input.thinking, isolation: 'local', archiveOnFinish: true };
    return schedule(payload(await this.actions.create({ name: input.name, prompt: input.prompt,
      cadence: scheduleCadence(input.cadence), target: { type: 'new-agent', config }, runOnCreate: false })).schedule);
  }
  async update(id: string, input: Parameters<ScheduleDriver['update']>[1]) {
    return schedule(payload(await this.actions.update({ id, prompt: input.prompt, cadence: scheduleCadence(input.cadence) })).schedule);
  }
  async pause(id: string) { return payload(await this.actions.pause({ id })); }
  async resume(id: string) { return payload(await this.actions.resume({ id })); }
  async remove(id: string) { return payload(await this.actions.delete({ id })); }
  async run(id: string) { return payload(await this.actions.runOnce({ id })); }
}
