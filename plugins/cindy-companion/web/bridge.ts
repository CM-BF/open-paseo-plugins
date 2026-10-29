export const CHANNEL = 'cindy-companion';
export type Init = { botId: string; host: { id: string; label: string }; theme: 'dark' | 'light'; locale: 'en' | 'zh-CN'; view?: 'settings' | 'presets' | 'teammate-create' | 'group-create' | 'group'; packageId?: string; groupId?: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const initListeners = new Set<(value: Init) => void>();
let currentInit: Init | null = null;
let sequence = 0;
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(`[${code}] ${message}`); this.name = 'BridgeError'; }
}
export function post(type: string, fields: Record<string, unknown> = {}) {
  window.parent.postMessage({ channel: CHANNEL, type, ...fields }, '*');
}
export function onInit(callback: (value: Init) => void) {
  initListeners.add(callback);
  if (currentInit) callback(currentInit);
  return () => initListeners.delete(callback);
}
export function initValue() { return currentInit; }
export function invoke<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!op || op.length > 128) return Promise.reject(new BridgeError('INVALID_ARGUMENT', 'Invalid operation'));
  if (new TextEncoder().encode(JSON.stringify(args)).length > 2 * 1024 * 1024)
    return Promise.reject(new BridgeError('INVALID_ARGUMENT', 'Request exceeds 2 MiB'));
  const id = `settings-${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError('TIMEOUT', 'The host did not confirm this operation. Your edits remain here.'));
    }, 45_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    post('request', { id, op, args });
  });
}
function responseError(value: unknown) {
  if (typeof value === 'string') return new BridgeError('HOST_ERROR', value);
  const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return new BridgeError(typeof error.code === 'string' ? error.code : 'HOST_ERROR', typeof error.message === 'string' ? error.message : 'The host rejected this operation.');
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.channel !== CHANNEL) return;
  if (message.type === 'init') {
    const value = message.init ?? message;
    if (typeof value.botId !== 'string' || !value.botId || value.botId.length > 256) return;
    if (value.theme !== 'dark' && value.theme !== 'light') return;
    currentInit = { botId: value.botId, host: value.host ?? { id: '', label: '' }, theme: value.theme, locale: value.locale === 'zh-CN' ? 'zh-CN' : 'en',
      view: ['presets', 'teammate-create', 'group-create', 'group'].includes(value.view) ? value.view : 'settings', ...(typeof value.groupId === 'string' && value.groupId.length <= 256 ? { groupId: value.groupId } : {}), ...(typeof value.packageId === 'string' && value.packageId.length <= 100 ? { packageId: value.packageId } : {}) };
    initListeners.forEach(listener => listener(currentInit!));
  } else if (message.type === 'request-close') {
    window.dispatchEvent(new Event('cindy-request-close'));
  } else if (message.type === 'response' && typeof message.id === 'string' && message.id.length <= 128) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error !== undefined) request.reject(responseError(message.error));
    else {
      const result = message.result;
      if (result && typeof result === 'object' && result.ok === false) request.reject(responseError(result));
      else request.resolve(result && typeof result === 'object' && result.ok === true ? result.value : result);
    }
  }
});
window.addEventListener('pagehide', () => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new BridgeError('CLOSED', 'Settings closed before the host replied.')); }
  pending.clear();
});
