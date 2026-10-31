import type { DraftStorage } from "./draft-store";

type BrowserStorageEvent = { key: string | null; storageArea?: unknown };
/** Access is guarded and isolated here; Hermes has no browser storage adapter. */
export function browserDraftStorage(): DraftStorage | null {
  const runtime = globalThis as unknown as { window?: {
    localStorage?: Omit<DraftStorage, "subscribe">;
    addEventListener?(name: "storage", listener: (event: BrowserStorageEvent) => void): void;
    removeEventListener?(name: "storage", listener: (event: BrowserStorageEvent) => void): void;
  } };
  try {
    const browser = runtime.window, storage = browser?.localStorage;
    if (!storage) return null;
    // Even reading storage.length can throw when the browser disallows persistence.
    void storage.length;
    return {
      get length() { return storage.length; },
      key: index => storage.key(index), getItem: key => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value), removeItem: key => storage.removeItem(key),
      subscribe(listener) {
        const changed = (event: BrowserStorageEvent) => { if (!event.storageArea || event.storageArea === storage) listener(event.key); };
        browser.addEventListener?.("storage", changed);
        return () => browser.removeEventListener?.("storage", changed);
      },
    };
  } catch { return null; }
}
