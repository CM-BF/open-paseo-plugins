// Test support only: an in-memory stand-in for the Paseo daemon's agent SDK as a plugin server sees it.
// Like the daemon, agent creation runs the plugin's before("agent.create") and before("agent.session_open")
// hooks, so the agent receives exactly the MCP server, binding and instructions the plugin injects.
// Each message is appended to the agent's timeline (for the plugin's turn matching), runs the agent's
// scripted behaviour, then emits agent.turn_ended. No daemon, network or real model is involved.

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * @param {{ before(name: string, request: object): Promise<object>, emit(name: string, event: object): Promise<void> }} host
 *   The plugin's registered hooks, called with the daemon's request and event shapes.
 */
export function createFakePaseo(host) {
  const agents = new Map(), records = new Map(), handles = new Map();
  const sends = [], created = [], errors = [];
  let turns = 0;
  const fake = {
    agents, records, sends, created, errors,
    /** provider ID → the daemon's provider mode list (`paseo.providers.listModes`), and the IDs asked for. */
    providerModes: new Map(), modeRequests: [],
    /** (record) => (message) => Promise<void>: the scripted behaviour of a newly created agent. */
    behaviour: () => undefined,
    addAgent(id, fields = {}) {
      agents.set(id, { id, title: null, provider: 'claude', model: 'sonnet', cwd: `/tmp/${id}`, workspaceId: null, status: 'idle', activeTurn: null,
        pendingPermissions: [], archivedAt: null, thinkingOptionId: null, currentModeId: null, availableModes: [], features: [], labels: {}, ...fields });
      records.set(id, { id, timeline: [], config: null, env: {}, behaviour: undefined, ...records.get(id) });
      return agents.get(id);
    },
    /** Resolves when no scripted turn is still running. */
    async idle() { while (running.size) await Promise.allSettled([...running]); },
    api: undefined,
  };
  const running = new Set();
  const page = (id, options = {}) => {
    const entries = (records.get(id)?.timeline ?? []).filter(entry => entry.seqEnd > (options.cursor?.seq ?? 0));
    return { entries, epoch: 'epoch-1', reset: false, staleCursor: false, hasOlder: false, hasNewer: false,
      window: { minSeq: entries[0]?.seqStart ?? 1, maxSeq: entries.at(-1)?.seqEnd ?? 0, nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1 },
      startCursor: entries.length ? { epoch: 'epoch-1', seq: entries[0].seqStart } : null,
      endCursor: entries.length ? { epoch: 'epoch-1', seq: entries.at(-1).seqEnd } : null, error: null };
  };
  const append = (id, item, turnId) => {
    const timeline = records.get(id).timeline, seq = timeline.length + 1;
    timeline.push({ item, provider: agents.get(id).provider, seqStart: seq, seqEnd: seq, timestamp: new Date().toISOString(), turnId, sourceSeqRanges: [], collapsed: [] });
  };
  async function runTurn(id, text, turnId) {
    const agent = agents.get(id), record = records.get(id);
    let failed = false;
    try {
      // The daemon reports the turn after the send call has returned to the plugin.
      await new Promise(resolve => setTimeout(resolve, 50));
      await record.behaviour?.({ text, turnId });
      append(id, { type: 'assistant_message', text: 'done' }, turnId);
    } catch (error) { failed = true; errors.push({ id, turnId, error }); }
    finally {
      Object.assign(agent, { status: 'idle', activeTurn: null });
      await host.emit('agent.turn_ended', { agent: clone(agent), outcome: { kind: failed ? 'failed' : 'completed' }, turnId });
    }
  }
  function ref(id) {
    if (handles.has(id)) return handles.get(id);
    const handle = {
      id,
      refresh: async () => agents.has(id) ? { agent: clone(agents.get(id)), project: null } : null,
      current: () => agents.has(id) ? clone(agents.get(id)) : null,
      send: async (text, options = {}) => {
        if (!agents.has(id)) throw new Error(`Unknown agent ${id}`);
        const turnId = `turn-${++turns}`;
        sends.push({ id, text, options: clone(options), turnId });
        append(id, { type: 'user_message', text, clientMessageId: options.messageId }, turnId);
        Object.assign(agents.get(id), { status: 'running', activeTurn: { id: turnId } });
        const work = runTurn(id, text, turnId);
        running.add(work); void work.finally(() => running.delete(work));
      },
      timeline: {
        subscribe: () => Object.assign(() => undefined, { ready: Promise.resolve(), release: async () => undefined }),
        refetch: async options => page(id, options),
      },
    };
    handles.set(id, handle);
    return handle;
  }
  async function create(options) {
    created.push(clone(options));
    const existing = [...records.values()].find(record => record.idempotencyKey && record.idempotencyKey === options.idempotencyKey);
    if (existing) return ref(existing.id);
    const injected = await host.before('agent.create', { config: clone(options.config), env: {} });
    const id = `agent-${created.length}`;
    const [provider, model] = String(injected.config.provider).split('/');
    fake.addAgent(id, { title: options.title ?? null, provider, model: model ?? null, cwd: options.cwd, labels: clone(options.labels ?? {}),
      currentModeId: injected.config.modeId ?? null, thinkingOptionId: injected.config.thinkingOptionId ?? null,
      availableModes: clone(agents.get('owner')?.availableModes ?? []) });
    const opened = await host.before('agent.session_open', { agentId: id, workspaceId: null, provider: injected.config.provider, cwd: options.cwd, reason: 'create', purpose: 'interactive', env: { ...injected.env } });
    Object.assign(records.get(id), { idempotencyKey: options.idempotencyKey, config: injected.config, env: opened.env, title: options.title });
    records.get(id).behaviour = fake.behaviour(records.get(id));
    return ref(id);
  }
  fake.api = {
    agents: { ref, create },
    workspaces: { ref: () => ({ agents: { create } }) },
    providers: {
      listModes: async provider => {
        fake.modeRequests.push(provider);
        const modes = fake.providerModes.get(provider);
        return { provider, ...(modes ? { modes: clone(modes), error: null } : { error: `Unknown provider: ${provider}` }), fetchedAt: new Date().toISOString(), requestId: `modes-${fake.modeRequests.length}` };
      },
    },
  };
  return fake;
}
