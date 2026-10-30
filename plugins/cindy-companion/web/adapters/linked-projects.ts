import type { BotProjectOption } from '../../vendor/shared/botWorkbench';

type Owner = { hostId: string; botId: string; generation: number };
type Request = (op: string, args: Record<string, unknown>) => Promise<unknown>;
type Scope = { key: string; revision: string | null; sequence: number; writing: boolean };
type Change = { botId: string };

function result(value: unknown): { projects: BotProjectOption[]; revision: string } {
  const page = value as { projects?: unknown; revision?: unknown } | null;
  if (!page || typeof page.revision !== 'string' || !page.revision || page.revision.length > 256 || !Array.isArray(page.projects))
    throw new Error('The host returned an invalid linked project list. Reload to try again.');
  const ids = new Set<string>();
  const projects = page.projects.map((value: unknown) => {
    const row = value as BotProjectOption | null;
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)
      || typeof row.name !== 'string' || typeof row.path !== 'string' || !row.path
      || typeof row.linked !== 'boolean' || typeof row.available !== 'boolean'
      || (row.deviceId !== undefined && typeof row.deviceId !== 'string'))
      throw new Error('The host returned an invalid linked project list. Reload to try again.');
    ids.add(row.id);
    return { id: row.id, name: row.name, path: row.path, linked: row.linked, available: row.available,
      ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}) };
  });
  return { projects, revision: page.revision };
}

/** Preserve Cindy's array API while keeping Paseo's CAS version private to this owner. */
export function createLinkedProjectsAdapter(request: Request, owner: () => Owner | null) {
  let scope: Scope | null = null;
  const listeners = new Set<{ key: string; callback(change: Change): void }>();
  const ownerKey = () => { const value = owner(); return value ? JSON.stringify([value.hostId, value.botId, value.generation]) : null; };
  const current = (value: Scope) => scope === value && ownerKey() === value.key;
  function getScope(botId: string): Scope {
    const selected = owner();
    if (!selected || selected.botId !== botId) throw new Error('The selected teammate changed.');
    const key = ownerKey()!;
    if (scope?.key !== key) scope = { key, revision: null, sequence: 0, writing: false };
    return scope;
  }
  function requireCurrent(value: Scope, sequence: number) {
    if (!current(value) || sequence !== value.sequence) throw new Error('The selected teammate changed. Reload its linked projects.');
  }
  return {
    async list(botId: string): Promise<BotProjectOption[]> {
      const own = getScope(botId);
      if (own.writing) throw new Error('Wait for the current change before reloading.');
      const sequence = ++own.sequence;
      own.revision = null;
      const page = result(await request('projects.list', { botId }));
      requireCurrent(own, sequence);
      own.revision = page.revision;
      return page.projects;
    },
    async set(botId: string, projectId: string, linked: boolean): Promise<BotProjectOption[]> {
      const own = getScope(botId);
      if (own.writing) throw new Error('A linked project change is already awaiting confirmation.');
      if (!own.revision) throw new Error('Reload linked projects before making another change.');
      const expectedRevision = own.revision;
      const sequence = ++own.sequence;
      own.revision = null;
      own.writing = true;
      try {
        const page = result(await request('projects.set', { botId, projectId, linked, expectedRevision }));
        requireCurrent(own, sequence);
        own.revision = page.revision;
        for (const entry of listeners) if (entry.key === own.key) entry.callback({ botId });
        return page.projects;
      } catch (error) {
        // A missing ACK is not a failed write. Require an explicit fresh read; never resend.
        own.revision = null;
        throw error;
      } finally { own.writing = false; }
    },
    onChanged(callback: (change: Change) => void) {
      const key = ownerKey();
      if (key === null) return () => {};
      const entry = { key, callback };
      listeners.add(entry);
      return () => { listeners.delete(entry); };
    },
  };
}
