import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BOT_PACKAGE_IDS, applyNativeLocale, readNativeBotPackage } from './catalog';
import type { SavedPresetReceipt } from './install-state';
import type { ImportItem } from './types';
import type { CompanionStore } from '../store';
import { CompanionMemoryStore } from '../memory';
import { CompanionError, string, throwIpcError } from '../errors';
import type { CompanionImportCheck } from '../../shared/vendor/presetImport';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const failure = (error: unknown) => error instanceof Error ? error.message : 'This item could not be saved';

/** Offline invites preserve a durable receipt and never activate schedules or run scripts. */
export class PresetImports {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: CompanionStore) {}
  private serial<T>(run: () => Promise<T>) {
    const next = this.queue.catch(() => {}).then(run); this.queue = next; return next;
  }
  async list() {
    const state = await this.store.snapshot();
    return Promise.all(BOT_PACKAGE_IDS.map(async id => {
      const pkg = await readNativeBotPackage(id);
      const receipt = Object.values(state.presetImports ?? {}).find(value => value.packageId === id &&
        value.packageHash === pkg.identity.packageHash && Boolean(state.profiles[value.result.botId]));
      return { ...pkg.entry, ...(receipt ? { installation: receipt.result } : {}) };
    }));
  }
  async status(requestId: string) {
    const state = await this.store.snapshot();
    const receipt = state.presetImports?.[requestId];
    return receipt && state.profiles[receipt.result.botId] ? receipt.result : undefined;
  }
  invite(args: Record<string, unknown>) {
    return this.serial(async () => {
      const pkg = await readNativeBotPackage(string(args.packageId, 'packageId', 100));
      if (args.packageVersion !== pkg.identity.packageVersion || args.packageHash !== pkg.identity.packageHash)
        throwIpcError('PACKAGE_CHANGED', 'The selected package has changed. Reopen the catalog.');
      const locale = args.locale === undefined ? undefined : string(args.locale, 'locale', 40);
      const state = await this.store.snapshot();
      let receipt = Object.values(state.presetImports ?? {}).find(value => value.packageId === pkg.identity.packageId &&
        value.packageHash === pkg.identity.packageHash && (!value.result.botId || Boolean(state.profiles[value.result.botId])));
      if (!receipt) {
        const requestId = randomUUID();
        receipt = { ...pkg.identity, locale, createdAt: Date.now(), files: [], routineIds: {},
          result: { requestId, botId: '', status: 'running', checks: [], savedEntryIds: [] } };
        await this.save(receipt);
      }
      // A retry keeps the originally selected language and creation payload.
      applyNativeLocale(pkg, receipt.locale);
      if (!receipt.result.botId) {
        const profile = await this.store.create({ operationId: `preset:${receipt.result.requestId}`, name: pkg.snapshot.source.name,
          description: pkg.snapshot.nativePackage!.description, identitySource: pkg.snapshot.items.find(item => item.role === 'identity')!.text,
          avatar: `data:image/webp;base64,${pkg.snapshot.avatarImageBase64}` });
        receipt.result.botId = profile.id; receipt.opening = pkg.snapshot.nativePackage?.opening;
        await this.save(receipt);
      }
      const botId = receipt.result.botId;
      receipt.result.status = 'running'; await this.save(receipt);
      for (const item of pkg.snapshot.items) {
        // Already saved content may have been edited by the owner. Retry only failed items.
        if (receipt.result.savedEntryIds?.includes(item.view.id)) continue;
        let check: CompanionImportCheck;
        try {
          await this.saveItem(receipt, item);
          check = { entryId: item.view.id, status: item.automation ? 'paused' : 'copied' };
          receipt.result.savedEntryIds = [...new Set([...(receipt.result.savedEntryIds ?? []), item.view.id])];
        } catch (error) { check = { entryId: item.view.id, status: 'needs-attention', message: failure(error) }; }
        receipt.result.checks = [...receipt.result.checks.filter(value => value.entryId !== item.view.id), check];
        await this.save(receipt);
      }
      const profile = await this.store.get(botId);
      const skills = receipt.result.checks.filter(check => check.entryId.startsWith('skill-') && check.status === 'copied').map(check => check.entryId.slice(6));
      if (skills.some(id => !profile.skills.includes(id))) await this.store.update(botId, { skills: [...new Set([...profile.skills, ...skills])] }, profile.currentVersion);
      receipt.result.saved = true;
      receipt.result.status = receipt.result.checks.some(check => check.status === 'needs-attention') ? 'needs-attention' : 'complete';
      await this.save(receipt); return receipt.result;
    });
  }
  private save(receipt: SavedPresetReceipt) {
    return this.store.transaction(state => { (state.presetImports ??= {})[receipt.result.requestId] = structuredClone(receipt); });
  }
  private async copy(path: string, bytes: Buffer) {
    await this.store.safePath(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await this.store.safePath(path);
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await this.store.safePath(path);
    if (!(await readFile(path)).equals(bytes)) throw new CompanionError('PRESET_CONTENT_CHANGED', 'Existing content differs; it was kept unchanged');
  }
  private async saveItem(receipt: SavedPresetReceipt, item: ImportItem) {
    const profile = await this.store.get(receipt.result.botId);
    if (item.role === 'identity') return; // Created atomically with the profile, never overwrite later edits.
    if (item.view.category === 'skills' && item.files) {
      for (const file of item.files) {
        const path = `skills/${item.view.name}/${file.name}`;
        if (path.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
          throwIpcError('UNSAFE_PATH', 'Invalid packaged skill path');
        await this.copy(join(profile.homeDir, path), file.bytes);
        receipt.files = [...receipt.files.filter(value => value.path !== path), { path, sha256: hash(file.bytes), skillId: item.view.name }];
      }
      return;
    }
    if (item.view.category === 'memory' && item.text) {
      if (!profile.capabilities.memory) throwIpcError('MEMORY_DISABLED', 'Memory is disabled; the reference was not imported');
      const memory = new CompanionMemoryStore(join(profile.homeDir, 'memories'), () => this.store.checkHome(profile.id));
      const name = `preset_${hash(`${receipt.packageId}:${item.view.id}`).slice(0, 32)}`;
      const filename = `reference_${name}.md`;
      const existing = (await memory.list()).find(value => value.filename === filename);
      if (existing) {
        if (existing.body !== item.text) throwIpcError('PRESET_CONTENT_CHANGED', 'The reference has changed; the existing content was kept');
      } else await memory.write({ name, type: 'reference', title: item.view.name, description: item.view.name, body: item.text, preserveBody: true });
      return;
    }
    if (item.automation?.input) {
      const id = receipt.routineIds[item.view.id] ?? randomUUID();
      receipt.routineIds[item.view.id] = id; await this.save(receipt);
      const now = Date.now();
      await this.store.transaction(state => {
        if (state.routines[id] || state.presetRoutineDrafts?.[id]) return;
        (state.presetRoutineDrafts ??= {})[id] = { botId: profile.id,
          data: { ...item.automation!.input!, enabled: false, id, botId: profile.id, revision: 1, createdAt: now, updatedAt: now } };
      });
      return;
    }
    throwIpcError('UNSUPPORTED_PRESET_ITEM', 'This package item cannot be imported by this host');
  }
}
