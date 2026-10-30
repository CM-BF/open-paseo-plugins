import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStorage } from './vendor/memory/storage';
import type { MemoryRecord, SearchOptions, WriteOptions } from './vendor/memory/types';
import { CompanionError } from './errors';

/** The upstream filesystem store is authoritative. This adapter uses literal text search, not FTS. */
export class CompanionMemoryStore {
  private readonly storage: MemoryStorage;
  private readonly directory: string;
  private readonly checkOwner: () => Promise<void>;
  constructor(directory: string, checkOwner: () => Promise<void>) {
    this.directory = directory; this.storage = new MemoryStorage(directory); this.checkOwner = checkOwner;
  }
  private async ready(): Promise<void> {
    await this.checkOwner();
    await this.storage.init(this.directory);
    // Refuse symlinks before handing paths to unmodified upstream storage.
    for (const name of await readdir(this.directory)) {
      if ((await lstat(join(this.directory, name))).isSymbolicLink())
        throw new CompanionError('UNSAFE_PATH', 'Memory files cannot be symbolic links');
    }
  }
  async list() { await this.ready(); return this.storage.list(); }
  async read(filename: string) { await this.ready(); return this.storage.read(filename); }
  async write(input: WriteOptions) { await this.ready(); return this.storage.write(input); }
  async update(filename: string, expected: string, changes: Pick<WriteOptions, 'title' | 'description' | 'body'>) {
    await this.ready(); return this.storage.update(filename, expected, changes);
  }
  async delete(filename: string, expected?: string) { await this.ready(); return this.storage.delete(filename, expected); }
  async getIndex() { await this.ready(); await this.storage.rebuildIndex(); return this.storage.getIndex(); }
  async search(query: string, options: SearchOptions = {}) {
    const needle = query.toLocaleLowerCase();
    return (await this.list()).filter((r: MemoryRecord) => `${r.frontmatter.title}\n${r.body}`.toLocaleLowerCase().includes(needle))
      .slice(0, options.limit ?? 50).map(r => ({ filename: r.filename, type: r.frontmatter.type }));
  }
}
