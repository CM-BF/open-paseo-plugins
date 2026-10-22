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
  globalThis.Date = SafeDate;
  Math.random = function () { unavailable('Math.random()'); };

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
    host.emit('log', J.stringify({ message: label + ' failed: ' + text(error), group: null }));
  }

  function makeApi(scope) {
    var currentPhase = null;
    function scoped(title) {
      return scope.group ? scope.group + ' › ' + title : title;
    }
    function phase(title) {
      if (typeof title !== 'string' || !title.trim()) throw new TypeError('phase() expects a non-empty title string');
      currentPhase = scoped(title.trim());
      host.emit('phase', J.stringify({ title: currentPhase }));
    }
    function log(message) {
      host.emit('log', J.stringify({ message: text(message), group: scope.group }));
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
        var fn = host.compile(source.body, source.filename);
        var child = makeApi({ group: source.name, depth: 1 });
        return fn(childArgs === undefined ? undefined : fromJson(J.stringify(childArgs)), child.agent, child.phase, child.log, child.workflow);
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
          if (failed) return null;
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

  var root = makeApi({ group: null, depth: 0 });
  var globals = {
    agent: root.agent,
    phase: root.phase,
    log: root.log,
    workflow: root.workflow,
    parallel: parallel,
    pipeline: pipeline,
    budget: budget,
    console: Object.freeze({ log: root.log, info: root.log, warn: root.log, error: root.log, debug: root.log }),
  };
  Object.keys(globals).forEach(function (name) {
    Object.defineProperty(globalThis, name, { value: globals[name], writable: false, configurable: false, enumerable: false });
  });

  return function start(fn, argsJson) {
    var args = fromJson(argsJson);
    Object.defineProperty(globalThis, 'args', { value: args, writable: false, configurable: false, enumerable: false });
    return Promise.resolve().then(function () {
      return fn(args, root.agent, root.phase, root.log, root.workflow);
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

const context = vm.createContext({}, { name: 'workflow', codeGeneration: { strings: false, wasm: false } });
const host = {
  maxItems: data.maxItems,
  budgetTotal: data.budgetTotal,
  request(op, json) {
    if (stopped) return Promise.reject(stopError());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ t: 'request', id, op, json });
    });
  },
  emit(op, json) {
    post({ t: 'event', op, json });
  },
  spent() {
    return spent;
  },
  compile(body, filename) {
    const source = '(async function (args, agent, phase, log, workflow) {\n' + body + '\n})';
    return new vm.Script(source, { filename, lineOffset: -1 }).runInContext(context);
  },
};

process.on('unhandledRejection', (reason) => {
  const text = reason && reason.message ? reason.message : String(reason);
  post({ t: 'event', op: 'log', json: JSON.stringify({ message: 'Swallowed an unhandled rejection (a promise from agent(), parallel(), pipeline() or workflow() was never awaited): ' + text, group: null }) });
});

parentPort.on('message', (message) => {
  if (message.t === 'reply') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.json);
    else entry.reject(message.error);
  } else if (message.t === 'spent') {
    spent = message.value;
  } else if (message.t === 'ping') {
    post({ t: 'pong' });
  } else if (message.t === 'stop') {
    stopped = true;
    for (const entry of pending.values()) entry.reject(stopError());
    pending.clear();
  }
});

let start;
let main;
try {
  start = new vm.Script(data.prelude, { filename: 'workflow-runtime.js' }).runInContext(context)(host);
  main = host.compile(data.body, data.filename);
} catch (error) {
  post({ t: 'done', ok: false, error: describe(error) });
}
if (main) {
  start(main, data.argsJson).then(
    (json) => post({ t: 'done', ok: true, json }),
    (error) => post({ t: 'done', ok: false, error: describe(error) }),
  );
}
`;
