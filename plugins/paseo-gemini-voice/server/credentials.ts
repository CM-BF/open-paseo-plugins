import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writePrivateFileAtomic } from "./files";
import { pluginDataDir } from "./paths";

interface CredentialFile {
  version: 1;
  proxyToken: string;
  geminiApiKey?: string;
}

const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

export function keyHint(key: string): string {
  if (key.length <= 10) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Secrets live in a 0600 file under the plugin data directory, never in the settings document:
 * settings are readable by every client of the host. The Gemini key never leaves the daemon.
 */
export class CredentialStore {
  private data: CredentialFile | null = null;

  constructor(
    readonly path = join(pluginDataDir(), "credentials.json"),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private load(): CredentialFile {
    if (this.data) return this.data;
    const raw = readJsonFile(this.path) as Partial<CredentialFile> | undefined;
    if (raw && typeof raw.proxyToken === "string" && raw.proxyToken.length >= 32) {
      this.data = {
        version: 1,
        proxyToken: raw.proxyToken,
        ...(typeof raw.geminiApiKey === "string" && raw.geminiApiKey ? { geminiApiKey: raw.geminiApiKey } : {}),
      };
      return this.data;
    }
    this.data = { version: 1, proxyToken: randomBytes(32).toString("base64url") };
    this.save();
    return this.data;
  }

  private save(): void {
    if (!this.data) return;
    writePrivateFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  proxyToken(): string {
    return this.load().proxyToken;
  }

  /** Constant-time comparison of a bearer token presented to the local proxy. */
  matchesProxyToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(this.proxyToken());
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  apiKey(): { key: string; source: "plugin" | "env" } | null {
    const stored = this.load().geminiApiKey;
    if (stored) return { key: stored, source: "plugin" };
    for (const name of ENV_KEYS) {
      const value = this.env[name]?.trim();
      if (value) return { key: value, source: "env" };
    }
    return null;
  }

  setApiKey(key: string): void {
    this.load().geminiApiKey = key.trim();
    this.save();
  }

  clearApiKey(): boolean {
    const data = this.load();
    if (!data.geminiApiKey) return false;
    delete data.geminiApiKey;
    this.save();
    return true;
  }
}
