export class CompanionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'CompanionError'; }
}
export function throwIpcError(code: string, message: string): never { throw new CompanionError(code, message); }
export function unsupported(feature: string): never { throwIpcError('UNSUPPORTED', `${feature} is not connected on this host.`); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throwIpcError('INVALID_PARAMS', 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 65536, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value, 'utf8') > max)
    throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  return value;
}
export function botId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) || ['constructor', 'prototype'].includes(value)) throwIpcError('INVALID_PARAMS', 'Invalid companion id');
  return value;
}
