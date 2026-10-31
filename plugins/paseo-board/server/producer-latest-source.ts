/** Optional application-side coalescing; appended to the installed feed.mjs. */
export const LATEST_PRODUCER_SOURCE = String.raw`
/** Coalesce quiet latest-state values in memory, never records or milestones.
 * offer() snapshots immediately. Its promise resolves to committed + original
 * ACK, superseded, or cancelled; transport errors reject with the original error.
 * A rejected offer stays rejected after recovery; retry() supplies its own result.
 * Staged values are VOLATILE. Only feed.set() supplies durable pending recovery.
 * flush()/drain() send without the delay and wait for idle. A failed submission
 * blocks all later values until retry() settles that exact feed request.
 * Recovery checks the retained request, then uses guarded feed.retry(request).
 * Missing/mismatched pending state raises retry_mismatch, never an older ACK.
 * flush()/drain() return the latest committed raw ACK (undefined before a write).
 * retry() returns committed + ACK, or closed + raw close result. If close()'s
 * drain fails, explicitly retry the failed write and then call close() again.
 * close() drains then closes the feed. dispose() cancels staged work and waits
 * for any active call; it does NOT cancel, clear, retry, or close a durable request.
 * After awaiting dispose(), explicitly reconcile/reopen the raw feed as needed
 * before creating a new writer. Use raw feed operations only while this is idle.
 */
export function createLatestWriter(feed, options = {}) {
  const error = (code, message) => Object.assign(new Error(message), { code });
  if (!feed || ['set', 'retry', 'close', 'status'].some(method => typeof feed[method] !== 'function')) throw error('invalid_input', 'A latest-state feed from the matching installed SDK is required');
  if (feed.mode !== undefined && feed.mode !== 'latest') throw error('mode_conflict', 'Latest writers cannot coalesce record feeds');
  if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.keys(options).some(key => key !== 'delayMs')) throw error('invalid_input', 'Only delayMs is supported');
  const delayMs = options.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) throw error('invalid_input', 'delayMs must be finite and between 0 and 60000');

  // Observe every public rejection internally. Awaiting callers still receive
  // the original error; detached offers cannot cause unhandled rejections.
  const observed = promise => { promise.catch(() => {}); return promise; };
  const rejected = reason => observed(Promise.reject(reason));
  function deferred() {
    let resolve, reject;
    const promise = observed(new Promise((yes, no) => { resolve = yes; reject = no; }));
    return { promise, resolve, reject };
  }
  function snapshot(value, limit = 256000) {
    let nodes = 0, bytes = 0;
    const envelope = limit > 256000 ? 1 : 0;
    const charge = amount => { bytes += amount; if (bytes > limit) throw error('size_limit', 'Latest JSON exceeds ' + limit + ' bytes'); };
    const visit = (item, depth) => {
      if (++nodes > 100000 + envelope * 32 || depth > 64 + envelope) throw error('size_limit', 'Latest value is too complex');
      if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) { charge(JSON.stringify(item).length); return item; }
      if (typeof item === 'string') {
        if (Buffer.byteLength(item) > limit) throw error('size_limit', 'Latest JSON exceeds ' + limit + ' bytes');
        charge(Buffer.byteLength(JSON.stringify(item))); return item;
      }
      if (!item || typeof item !== 'object' || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw error('invalid_input', 'Latest values must be finite JSON');
      const array = Array.isArray(item), result = array ? [] : {};
      if (array && item.length > 100000) throw error('size_limit', 'Latest value is too complex');
      const keys = array ? Array.from({ length: item.length }, (_, i) => String(i)) : Object.keys(item);
      if (keys.length > 100000) throw error('size_limit', 'Latest value is too complex');
      charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) throw error('invalid_input', 'Latest values must contain JSON data, not accessors or sparse arrays');
        if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: false, configurable: false });
      }
      return Object.freeze(result);
    };
    return visit(value, 0);
  }
  function policySnapshot(policy) {
    const copy = snapshot(policy);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).some(key => !['attention', 'focusSelectors'].includes(key))) throw error('invalid_input', 'Latest writers accept only quiet attention and focusSelectors; use raw feed operations for records');
    if (copy.attention !== undefined && copy.attention !== 'quiet') throw error('mode_conflict', 'Milestones cannot be coalesced; flush first, then await raw feed.set with milestone attention');
    if (copy.focusSelectors !== undefined && (!Array.isArray(copy.focusSelectors) || copy.focusSelectors.length > 12 || copy.focusSelectors.some(selector => typeof selector !== 'string' || !selector.length || selector.length > 1000))) throw error('invalid_input', 'focusSelectors must be at most 12 nonempty selector strings of at most 1000 characters');
    return Object.freeze({ attention: 'quiet', ...(copy.focusSelectors === undefined ? {} : { focusSelectors: copy.focusSelectors }) });
  }
  function equal(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  async function recover(operation) {
    if (!operation.retryRequest) {
      const status = await feed.status(), pending = status?.local?.pending;
      if (!pending || pending.action !== operation.kind || operation.kind === 'set' && (!equal(pending.value, operation.value) || (pending.attention ?? 'quiet') !== operation.policy.attention || !equal(pending.focusSelectors, operation.policy.focusSelectors))) throw error('retry_mismatch', 'No matching retained request; inspect and reconcile the raw feed after disposal');
      operation.retryRequest = snapshot(pending, 600000);
    }
    return feed.retry(operation.retryRequest);
  }

  let staged, current, blocked, timer, drain, closeResult, disposeResult;
  let active = false, closing = false, closed = false, disposed = false;
  let lastAck, retryPromise, closedResult;
  function clearDelay() { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } }
  function finishDrain(reason, failed = false) {
    if (!drain) return;
    const result = drain; drain = undefined;
    if (failed) result.reject(reason); else result.resolve(lastAck);
  }
  function finishDispose() {
    if (disposed && !active && disposeResult) disposeResult.resolve(Object.freeze({ status: 'disposed', pending: !!current, ...(blocked ? { error: blocked.error } : {}) }));
  }
  function advance() {
    if (blocked) { finishDrain(blocked.error, true); finishDispose(); return; }
    if (active) return;
    if (disposed) { finishDispose(); return; }
    if (!staged) { finishDrain(); return; }
    if (drain || closing) { submit(); return; }
    if (timer === undefined) timer = setTimeout(() => { timer = undefined; submit(); }, delayMs);
  }
  function run(operation, invoke) {
    current = operation; active = true;
    const task = observed(Promise.resolve().then(invoke).then(ack => {
      active = false; blocked = undefined; current = undefined;
      if (operation.kind === 'close') {
        closed = true;
        const result = Object.freeze({ status: 'closed', result: ack });
        closedResult = result;
        operation.completion.resolve(result);
        finishDispose();
        return result;
      }
      lastAck = ack;
      const result = Object.freeze({ status: 'committed', ack });
      operation.completion.resolve(result);
      advance();
      return result;
    }, reason => {
      active = false; blocked = { error: reason };
      operation.completion.reject(reason);
      finishDrain(reason, true); finishDispose();
      throw reason;
    }));
    return task;
  }
  function submit() {
    clearDelay();
    if (current || !staged || disposed) return;
    const operation = staged; staged = undefined;
    run(operation, () => feed.set(operation.value, operation.policy));
  }
  function flush() {
    if (disposed) return rejected(error('writer_disposed', 'Latest writer is disposed; inspect status and reconcile the raw feed'));
    if (blocked) return rejected(blocked.error);
    if (current?.kind === 'close') return observed(closeResult.promise.then(() => lastAck));
    if (!current && !staged) return Promise.resolve(lastAck);
    if (!drain) drain = deferred();
    const result = drain.promise;
    clearDelay(); advance();
    return result;
  }
  const writer = {
    offer(value, policy = {}) {
      if (disposed || closing || closed) throw error('writer_closed', 'Latest writer no longer accepts offers');
      const operation = { kind: 'set', value: snapshot(value), policy: policySnapshot(policy), completion: deferred() };
      if (staged) staged.completion.resolve(Object.freeze({ status: 'superseded' }));
      staged = operation;
      advance();
      return operation.completion.promise;
    },
    flush,
    drain: flush,
    retry() {
      if (disposed) return rejected(error('writer_disposed', 'Await disposal, then reconcile the exact raw feed request'));
      if (retryPromise) return retryPromise;
      if (active) return rejected(error('producer_busy', 'Await the active latest write before retrying'));
      if (!current || !blocked) return rejected(error('no_pending_write', 'There is no blocked latest operation to retry'));
      const operation = current;
      const task = run(operation, () => recover(operation));
      retryPromise = task;
      observed(task.finally(() => { retryPromise = undefined; }));
      return task;
    },
    close() {
      if (closed) return Promise.resolve(closedResult);
      if (closeResult) return closeResult.promise;
      if (disposed) return rejected(error('writer_disposed', 'Disposed writers cannot close the raw feed'));
      closing = true; closeResult = deferred();
      const result = closeResult;
      observed(flush().then(() => {
        if (disposed) { result.reject(error('writer_disposed', 'Disposal cancelled closing before the raw close started')); return; }
        run({ kind: 'close', completion: result }, () => feed.close());
      }, reason => { result.reject(reason); closeResult = undefined; closing = false; }));
      return result.promise;
    },
    dispose() {
      if (disposeResult) return disposeResult.promise;
      disposed = true; clearDelay(); disposeResult = deferred();
      if (staged) { staged.completion.resolve(Object.freeze({ status: 'cancelled' })); staged = undefined; }
      finishDrain(error('writer_disposed', 'Disposal cancelled the flush; only committed offers are durable'), true);
      finishDispose();
      return disposeResult.promise;
    },
    status() {
      return Object.freeze({
        state: disposed ? 'disposed' : closed ? 'closed' : blocked ? 'blocked' : active ? 'writing' : closing ? 'closing' : staged ? 'scheduled' : 'idle',
        active, staged: !!staged, volatile: !!staged,
        ...(current ? { pending: Object.freeze({ action: current.kind, ...(current.kind === 'set' ? { value: current.value, policy: current.policy } : {}) }) } : {}),
        ...(blocked ? { error: blocked.error } : {}),
      });
    },
  };
  return Object.freeze(writer);
}
`;
