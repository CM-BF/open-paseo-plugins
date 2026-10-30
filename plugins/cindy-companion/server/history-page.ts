import type { GroupMessage } from '../shared/groups';
import { throwIpcError } from './errors';

export const HISTORY_BYTES = 1_700_000;
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function boundedHistory<T>(value: T): T {
  if (sizeOf(value) > HISTORY_BYTES) throwIpcError('HISTORY_WINDOW_TOO_LARGE', 'A required message projection exceeds the supported response size; history was not loaded');
  return value;
}
/** Keep full messages; reduce the contiguous page by actual serialized UTF-8 bytes. */
export function byteHistoryPage<T>(candidates: GroupMessage[], limit: number, build: (page: GroupMessage[], next: number | null) => T): T {
  const take = (count: number) => {
    const page = candidates.slice(-count);
    return build(page, count < candidates.length ? page[0]!.sequence : null);
  };
  const maximum = Math.min(limit, candidates.length);
  if (!maximum) return boundedHistory(build([], null));
  const full = take(maximum); if (sizeOf(full) <= HISTORY_BYTES) return full;
  let low = 1, high = maximum - 1, selected: T | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2), value = take(count);
    if (sizeOf(value) <= HISTORY_BYTES) { selected = value; low = count + 1; }
    else high = count - 1;
  }
  // An individual projection can still be invalid/corrupt. Never drop or trim its body.
  return selected ?? boundedHistory(take(1));
}
