import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { BoardSchema, IdSchema } from "../shared/contracts";

export const MAX_JSON_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 12_000_000;
const MAX_STORE_BYTES = 64_000_000;

export class BoardStoreError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BoardStoreError";
    this.code = code;
    this.details = details;
  }
}

const ReceiptSchema = z.object({ key: z.string(), fingerprint: z.string(), revision: z.number().int().positive() });
const HistorySchema = z.object({ revision: z.number().int().positive(), at: z.string(), operation: z.string(), payload: z.unknown() });
const EnvelopeSchema = z.object({
  storageVersion: z.literal(1), board: BoardSchema,
  receipts: z.array(ReceiptSchema), history: z.array(HistorySchema),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BoardStoreError("invalid_input", result.error.message);
  try { return structuredClone(result.data); }
  catch { throw new BoardStoreError("invalid_input", "Input cannot contain functions or other non-serializable values"); }
}

export function assertId(id: string): string {
  parseInput(IdSchema, id);
  if (id === "." || id === "..") throw new BoardStoreError("invalid_input", "Board ID cannot be a path segment");
  return id;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([, item]) => item !== undefined).map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

export function fingerprint(operation: string, payload: unknown): string {
  const serialized = canonicalJson({ operation, payload });
  assertSize(serialized, MAX_REQUEST_BYTES, "Request");
  return createHash("sha256").update(serialized).digest("hex");
}

export function assertJson(value: unknown, name: string): void {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) throw new BoardStoreError("size_limit", `${name} is too complex`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const element of item) visit(element, depth + 1); return; }
    if (item && typeof item === "object" && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const element of Object.values(item)) visit(element, depth + 1);
      return;
    }
    throw new BoardStoreError("invalid_input", `${name} must contain only finite JSON values`);
  }
  visit(value, 0);
  assertSize(JSON.stringify(value), MAX_JSON_BYTES, name);
}

function assertSize(serialized: string, limit: number, name: string): void {
  if (Buffer.byteLength(serialized, "utf8") > limit) throw new BoardStoreError("size_limit", `${name} exceeds ${limit} bytes; existing history has been retained`);
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BoardStoreError("unsafe_path", `Storage directory is not a regular directory: ${path}`);
}

export async function readEnvelope(path: string, expectedId: string): Promise<Envelope | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardStoreError("unsafe_path", `Board storage is not a regular file: ${path}`);
    if (stat.size > MAX_STORE_BYTES) throw new BoardStoreError("size_limit", `Board storage exceeds ${MAX_STORE_BYTES} bytes`);
    const data = JSON.parse(await readFile(path, "utf8"));
    const parsed = EnvelopeSchema.parse(data);
    if (parsed.board.id !== expectedId) throw new Error("Board identity does not match filename");
    const { board, history, receipts } = parsed;
    if (history.length !== board.revision || history.some((entry, index) => entry.revision !== index + 1)) throw new Error("History sequence does not match board revision");
    if (new Set(receipts.map(receipt => receipt.key)).size !== receipts.length || receipts.some(receipt => receipt.revision > board.revision)) throw new Error("Invalid receipt ledger");
    if (receipts.some(receipt => {
      const entry = history[receipt.revision - 1];
      return receipt.fingerprint !== fingerprint(entry.operation, entry.payload);
    })) throw new Error("Receipt does not match its committed history entry");
    for (const [name, items] of [["events", board.events], ["interactions", board.interactions], ["decisions", board.decisions], ["observations", board.observations]] as const) {
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Duplicate ${name} identities`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof BoardStoreError) throw error;
    throw new BoardStoreError("corrupt_storage", `Cannot read board ${expectedId}; data was not changed`, { path, cause: error instanceof Error ? error.message : String(error) });
  }
}

export async function writeEnvelope(path: string, envelope: Envelope): Promise<void> {
  // One rename commits state, journal and idempotency receipts together.
  const serialized = JSON.stringify(EnvelopeSchema.parse(envelope));
  assertSize(serialized, MAX_STORE_BYTES, "Board storage");
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(serialized, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, result);
  const cleanup = () => { if (queues.get(key) === result) queues.delete(key); };
  void result.then(cleanup, cleanup);
  return result;
}
