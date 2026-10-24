/**
 * The code that runs a workflow script. Both parts are plain JavaScript strings so no bundler
 * transform can touch them; neither may contain a backtick or a dollar-brace sequence.
 *
 * WORKER_SOURCE runs in a worker thread (`new Worker(src, { eval: true })`): a CPU-bound loop in a
 * script blocks only that thread, and stopping a run can terminate it.
 *
 * PRELUDE runs inside the script's `node:vm` context. Everything the script touches (agent(),
 * parallel(), results, errors) is created in that context's realm. Results cross the thread
 * boundary as JSON strings.
 */

export const PRELUDE = String.raw`(function (host) {
  'use strict';
  var J = JSON;
  var RealDate = Date;
  function unavailable(what) {
    throw new Error(what + ' is unavailable in workflow scripts because it would break resume. Pass timestamps in through args and stamp results after the workflow returns.');
  }
  function SafeDate() {
    if (!new.target) unavailable('Date()');
    if (arguments.length === 0) unavailable('new Date()');
    return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), new.target);
  }
  SafeDate.prototype = RealDate.prototype;
  SafeDate.parse = RealDate.parse;
  SafeDate.UTC = RealDate.UTC;
  SafeDate.now = function () { unavailable('Date.now()'); };
  Object.defineProperty(RealDate.prototype, 'constructor', { value: SafeDate, writable: false, configurable: false });
  globalThis.Date = SafeDate;
  Math.random = function () { unavailable('Math.random()'); };
  var dateTimePrototype = Intl.DateTimeFormat.prototype;
  var formatGetter = Object.getOwnPropertyDescriptor(dateTimePrototype, 'format').get;
  Object.defineProperty(dateTimePrototype, 'format', { get: function () {
    var format = formatGetter.call(this);
    return function (value) {
      if (value === undefined) unavailable('Intl.DateTimeFormat().format() without a date');
      return format(value);
    };
  } });
  var formatParts = dateTimePrototype.formatToParts;
  dateTimePrototype.formatToParts = function (value) {
    if (value === undefined) unavailable('Intl.DateTimeFormat().formatToParts() without a date');
    return formatParts.call(this, value);
  };

  function fromJson(text) {
    return text === undefined || text === null ? undefined : J.parse(text);
  }
  function toError(value) {
    if (value && typeof value === 'object') {
      var error = new Error(String(value.message));
      error.name = value.name || 'Error';
      if (value.hard) Object.defineProperty(error, '__workflowHardStop', { value: true });
      return error;
    }
    return new Error(String(value));
  }
  function isHard(error) {
    return !!(error && error.__workflowHardStop);
  }
  function text(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      var out = J.stringify(value);
      return out === undefined ? String(value) : out;
    } catch (e) {
      return String(value);
    }
  }
  function kind(value) {
    if (value === null) return 'null';
    if (value && typeof value.then === 'function') return 'a promise';
    return typeof value;
  }
  function call(op, payload) {
    return new Promise(function (resolve, reject) {
      host.request(op, payload).then(function (json) { resolve(fromJson(json)); }, function (e) { reject(toError(e)); });
    });
  }
  function note(where, index, error, stage) {
    var label = where + ' item ' + index + (stage === undefined ? '' : ' (stage ' + (stage + 1) + ')');
    host.emit('log', J.stringify({ message: (label + ' failed: ' + text(error)).slice(0, 2000), group: null }));
    host.failure(where.replace('()', '') + '[' + index + ']', (error && typeof error.message === 'string' ? error.message : text(error)).slice(0, 500));
  }

  function makeApi(scope) {
    var currentPhase = null;
    function scoped(title) {
      return scope.group ? scope.group + ' › ' + title : title;
    }
    function phase(title) {
      if (typeof title !== 'string' || !title.trim()) throw new TypeError('phase() expects a non-empty title string');
      currentPhase = scoped(title.trim().slice(0, 200));
      host.emit('phase', J.stringify({ title: currentPhase }));
    }
    function log(message) {
      host.emit('log', J.stringify({ message: text(message).slice(0, 2000), group: scope.group }));
    }
    function agent(prompt, opts) {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return Promise.reject(new TypeError('agent() expects a non-empty prompt string, got ' + kind(prompt)));
      }
      if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts))) {
        return Promise.reject(new TypeError('agent() options must be an object'));
      }
      var options = opts || {};
      if (options.phase !== undefined && typeof options.phase !== 'string') {
        return Promise.reject(new TypeError('agent() opts.phase must be a string'));
      }
      var payload;
      try {
        payload = J.stringify({
          prompt: prompt,
          opts: options,
          phase: options.phase !== undefined ? scoped(options.phase) : (currentPhase !== null ? currentPhase : scope.group),
        });
      } catch (e) {
        return Promise.reject(new TypeError('agent() options must be JSON-serializable: ' + e.message));
      }
      return call('agent', payload);
    }
    function workflow(ref, childArgs) {
      if (scope.depth > 0) return Promise.reject(new Error('workflow() nesting is one level only: a nested workflow cannot call workflow()'));
      var request;
      try {
        request = J.stringify({ ref: ref, args: childArgs === undefined ? null : childArgs });
      } catch (e) {
        return Promise.reject(new TypeError('workflow() args must be JSON-serializable: ' + e.message));
      }
      return call('workflow', request).then(function (source) {
        return new Promise(function (resolve, reject) {
          host.runNested(source, childArgs === undefined ? null : J.stringify(childArgs)).then(
            function (json) { resolve(fromJson(json)); },
            function (error) { reject(toError(error)); }
          );
        });
      });
    }
    return { agent: agent, phase: phase, log: log, workflow: workflow };
  }

  function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      return Promise.reject(new TypeError('parallel() expects an array of functions: parallel(items.map(item => () => agent(...)))'));
    }
    if (thunks.length > host.maxItems) {
      return Promise.reject(new RangeError('parallel() accepts at most ' + host.maxItems + ' items, got ' + thunks.length + '; split the work into batches'));
    }
    for (var i = 0; i < thunks.length; i++) {
      if (typeof thunks[i] !== 'function') {
        return Promise.reject(new TypeError('parallel() expects functions, not ' + kind(thunks[i]) + ' (item ' + i + '): wrap each call as () => agent(...)'));
      }
    }
    return Promise.all(thunks.map(function (thunk, index) {
      var started;
      try {
        started = Promise.resolve(thunk());
      } catch (e) {
        started = Promise.reject(e);
      }
      return started.then(undefined, function (e) {
        if (isHard(e)) throw e;
        note('parallel()', index, e);
        return null;
      });
    }));
  }

  function pipeline(items) {
    var stages = Array.prototype.slice.call(arguments, 1);
    if (!Array.isArray(items)) return Promise.reject(new TypeError('pipeline() expects an array as the first argument'));
    if (items.length > host.maxItems) {
      return Promise.reject(new RangeError('pipeline() accepts at most ' + host.maxItems + ' items, got ' + items.length + '; split the work into batches'));
    }
    if (stages.length === 0) return Promise.reject(new TypeError('pipeline() needs at least one stage: pipeline(items, item => ..., result => ...)'));
    for (var s = 0; s < stages.length; s++) {
      if (typeof stages[s] !== 'function') {
        return Promise.reject(new TypeError('pipeline() stages must be functions: pipeline(items, item => ..., result => ...) (stage ' + (s + 1) + ' is ' + kind(stages[s]) + ')'));
      }
    }
    return Promise.all(items.map(function (item, index) {
      var chain = Promise.resolve(item);
      var failed = false;
      stages.forEach(function (stage, stageIndex) {
        chain = chain.then(function (previous) {
          if (failed || previous === null) return null;
          return stage(previous, item, index);
        }).then(undefined, function (e) {
          if (isHard(e)) throw e;
          if (!failed) note('pipeline()', index, e, stageIndex);
          failed = true;
          return null;
        });
      });
      return chain;
    }));
  }

  var budget = Object.freeze({
    total: host.budgetTotal,
    spent: function () { return host.spent(); },
    remaining: function () {
      return host.budgetTotal === null ? Infinity : Math.max(0, host.budgetTotal - host.spent());
    },
  });

  var root = makeApi({ group: typeof host.group === 'string' ? host.group.slice(0, 200) : null, depth: host.depth });
  var globals = {
    agent: root.agent,
    phase: root.phase,
    log: root.log,
    workflow: root.workflow,
    parallel: parallel,
    pipeline: pipeline,
    budget: budget,
    guidance: Object.freeze({
      ultracode: Boolean(host.guidance && host.guidance.ultracode),
      size: host.guidance && typeof host.guidance.size === 'string' ? host.guidance.size : 'unrestricted',
    }),
    setTimeout: function (callback, delay) {
      if (typeof callback !== 'function') throw new TypeError('setTimeout() expects a function');
      return host.setTimer(callback, delay);
    },
    clearTimeout: function (id) { host.clearTimer(id); },
    console: Object.freeze({ log: root.log, info: root.log, warn: root.log, error: root.log, debug: root.log }),
  };
  Object.keys(globals).forEach(function (name) {
    Object.defineProperty(globalThis, name, { value: globals[name], writable: false, configurable: false, enumerable: false });
  });

  return function start(fn, argsJson) {
    var args = fromJson(argsJson);
    Object.defineProperty(globalThis, 'args', { value: args, writable: false, configurable: false, enumerable: false });
    return Promise.resolve().then(function () {
      return fn(args, root.agent, root.phase, root.log, root.workflow)();
    }).then(function (value) {
      if (value && typeof value.then === 'function') throw new TypeError('The script returned a promise: await it before returning');
      var json;
      try {
        json = J.stringify(value === undefined ? null : value);
      } catch (e) {
        throw new TypeError('The workflow result must be JSON-serializable: ' + e.message);
      }
      return json === undefined ? 'null' : json;
    });
  };
})`;

export const WORKER_SOURCE = String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

const data = workerData;
let spent = 0;
let nextId = 0;
let stopped = false;
const pending = new Map();
const timers = new Map();
let nextTimer = 0;
let requestCount = 0;
let pendingBytes = 0;
let eventWindow = Date.now();
let eventCount = 0;
let droppedEvents = 0;
const failures = new Map();
const changedFailures = new Set();
let failureFlush = false;

function post(message) {
  parentPort.postMessage(message);
}
function describe(error) {
  if (error && typeof error === 'object') {
    return { name: String(error.name || 'Error'), message: String(error.message), stack: typeof error.stack === 'string' ? error.stack : null };
  }
  return { name: 'Error', message: String(error), stack: null };
}
function stopError() {
  return { name: 'WorkflowStopped', message: 'The workflow was stopped', hard: true };
}
function clearTimers() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
function flushDropped() {
  if (!droppedEvents) return;
  post({ t: 'event', op: 'log', json: JSON.stringify({ message: 'Suppressed ' + droppedEvents + ' log/phase events: scripts may emit at most 100 events per second', group: null }) });
  droppedEvents = 0;
}
function failRequests(message) {
  stopped = true;
  clearTimers();
  post({ t: 'done', ok: false, error: { name: 'RangeError', message } });
  return Promise.reject(stopError());
}
const sharedHost = {
  maxItems: data.maxItems,
  budgetTotal: data.budgetTotal,
  guidance: data.guidance,
  request(op, json) {
    if (stopped) return Promise.reject(stopError());
    if (++requestCount > data.maxRequests) return failRequests('The script exceeded its request limit (' + data.maxRequests + '); await every agent()/workflow() call and split large runs into batches');
    const bytes = Buffer.byteLength(json);
    if (bytes > 2 * 1024 * 1024 || pendingBytes + bytes > 16 * 1024 * 1024) {
      return failRequests('The script queued too much request data; await calls or use smaller prompts and batches');
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pendingBytes += bytes;
      pending.set(id, { resolve, reject, bytes });
      post({ t: 'request', id, op, json });
    });
  },
  // Failures bypass the event rate limit: identical messages collapse into one counted entry,
  // flushed once per tick, so 400 slots rejected by a spent budget cost one message.
  failure(label, message) {
    if (stopped) return;
    const entry = failures.get(message);
    if (entry) entry.count++;
    else if (failures.size < 100) failures.set(message, { label, count: 1 });
    else return;
    changedFailures.add(message);
    if (failureFlush) return;
    failureFlush = true;
    Promise.resolve().then(() => {
      failureFlush = false;
      for (const key of changedFailures) {
        const item = failures.get(key);
        post({ t: 'event', op: 'failure', json: JSON.stringify({ label: item.label, message: key, count: item.count }) });
      }
      changedFailures.clear();
    });
  },
  emit(op, json) {
    if (stopped) return;
    if (json.length > 16384) { droppedEvents++; return; }
    if (Date.now() - eventWindow >= 1000) {
      flushDropped();
      eventWindow = Date.now();
      eventCount = 0;
    }
    if (++eventCount > 100) { droppedEvents++; return; }
    post({ t: 'event', op, json });
  },
  spent() {
    return spent;
  },
  setTimer(callback, delay) {
    if (stopped) return 0;
    const id = ++nextTimer;
    const milliseconds = typeof delay === 'number' || typeof delay === 'string' ? Number(delay) || 0 : 0;
    const timer = setTimeout(() => {
      timers.delete(id);
      if (stopped) return;
      try {
        Promise.resolve(callback()).catch((error) => sharedHost.emit('log', JSON.stringify({ message: ('Timer callback failed: ' + describe(error).message).slice(0, 2000), group: null })));
      } catch (error) {
        sharedHost.emit('log', JSON.stringify({ message: ('Timer callback failed: ' + describe(error).message).slice(0, 2000), group: null }));
      }
    }, milliseconds);
    timers.set(id, timer);
    return id;
  },
  clearTimer(id) {
    const key = Number(id);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  },
};

function run(body, filename, argsJson, group, depth) {
  const context = vm.createContext({}, { name: 'workflow', codeGeneration: { strings: false, wasm: false } });
  const host = Object.assign({}, sharedHost, {
    group, depth,
    runNested(source, childArgsJson) {
      if (depth > 0) return Promise.reject({ name: 'Error', message: 'workflow() nesting is one level only' });
      return run(source.body, source.filename, childArgsJson, source.name, 1).catch((error) => { throw describe(error); });
    },
  });
  const start = new vm.Script(data.prelude, { filename: 'workflow-runtime.js' }).runInContext(context)(host);
  const source = '(function (args, agent, phase, log, workflow) { return async function () {\n\'use strict\';\n' + body + '\n}; })';
  const main = new vm.Script(source, { filename, lineOffset: -2 }).runInContext(context);
  return start(main, argsJson);
}

process.on('unhandledRejection', (reason) => {
  const text = reason && reason.message ? reason.message : String(reason);
  sharedHost.emit('log', JSON.stringify({ message: ('Swallowed an unhandled rejection (a promise from agent(), parallel(), pipeline() or workflow() was never awaited): ' + text).slice(0, 2000), group: null }));
});

parentPort.on('message', (message) => {
  if (message.t === 'reply') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    pendingBytes -= entry.bytes;
    if (message.ok) entry.resolve(message.json);
    else entry.reject(message.error);
  } else if (message.t === 'spent') {
    spent = message.value;
  } else if (message.t === 'ping') {
    post({ t: 'pong' });
  } else if (message.t === 'stop') {
    stopped = true;
    clearTimers();
    for (const entry of pending.values()) entry.reject(stopError());
    pending.clear();
    pendingBytes = 0;
  }
});

function done(payload) {
  clearTimers();
  flushDropped();
  stopped = true;
  post(Object.assign({ t: 'done' }, payload));
}
try {
  run(data.body, data.filename, data.argsJson, null, 0).then(
    (json) => done({ ok: true, json }),
    (error) => done({ ok: false, error: describe(error) }),
  );
} catch (error) {
  done({ ok: false, error: describe(error) });
}
`;
