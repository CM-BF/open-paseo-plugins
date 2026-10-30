import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema, ItemSchema, type Config, type Item, type IssueSnapshot, type Overview, type Run, VERSION } from "../shared/types";
import { GitHubClient, GitHubError, type RawIssue } from "./github";
import { Store } from "./store";
import type { WorkerPort } from "./worker";

const iso = (now: number) => new Date(now).toISOString();
const keyOf = (snapshot: IssueSnapshot) => `${snapshot.repo.toLowerCase()}#${snapshot.number}`;
const active = (item: Item) => item.run?.phase === "reserved" || item.run?.phase === "running";
const backoff = (attempt: number) => Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt - 1, 7));
function safeError(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  // Worker errors are deliberately sanitized at their transport boundary.
  if (error instanceof Error && error.name === "WorkerError") return error.message.slice(0, 500);
  return "The operation failed. Check local connectivity and provider availability, then retry.";
}

export class TriageService {
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private scanning = false;
  private workerError: string | null = null;
  constructor(readonly store: Store, readonly github: GitHubClient, readonly worker: WorkerPort, private now = Date.now) {}

  start(): void { this.schedule(20); }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    await this.tail.catch(() => undefined);
    await this.worker.dispose();
    this.store.close();
  }
  overview(): Overview {
    const { owner, config, scan, items } = this.store.state;
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    // Return a detached view: no RPC caller can mutate the queue's durable reservation.
    return structuredClone({ version: VERSION, owner, config, scan, scanning: this.scanning, workerError: this.store.error ?? this.workerError, items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), counts });
  }
  configure(input: Config): Promise<Overview> {
    return this.exclusive(async () => {
      const config = ConfigSchema.parse(input);
      config.repos = [...new Set(config.repos)];
      if (config.enabled && config.repos.length === 0) throw new Error("Add at least one repository before enabling intake.");
      if (!this.store.state.owner || config.enabled) { this.requireApiReady(); await this.verifyIdentity(); }
      if (config.enabled) await this.worker.validate(config.worker);
      for (const item of this.store.state.items) {
        if (item.source === "github" && !config.repos.includes(item.snapshot.repo) && active(item)) {
          await this.worker.stop(item.run!);
          this.fail(item, "Repository removed from the allowlist. Worker stopped.");
        }
      }
      const state = this.store.state;
      state.config = config;
      if (!config.enabled) for (const item of state.items) if (item.source === "github" && item.run?.phase === "reserved") item.status = "queued";
      if (config.enabled && !state.enabledAt) state.enabledAt = iso(this.now());
      for (const repo of Object.keys(state.scan.cursors)) if (!config.repos.includes(repo)) delete state.scan.cursors[repo];
      // A larger explicit backfill window can queue previously discovered history.
      if (config.backfillDays > 0) for (const item of state.items) {
        if (item.source === "github" && config.repos.includes(item.snapshot.repo) && item.status === "discovered" && this.inBackfill(item.snapshot)) item.status = "queued";
      }
      if (!state.scan.error) state.scan.nextAt = 0;
      this.store.save();
      return this.overview();
    });
  }
  scanNow(): Promise<Overview> {
    return this.exclusive(async () => {
      if (this.store.state.scan.failures > 0 && this.store.state.scan.nextAt > this.now()) return this.overview();
      await this.scan();
      return this.overview();
    });
  }
  intake(repo: string, number: number): Promise<Overview> {
    return this.exclusive(async () => {
      this.assertAllowed(repo);
      this.requireApiReady();
      await this.verifyIdentity();
      const raw = await this.github.getIssue(repo, number);
      const snapshot = await this.github.snapshot(repo, raw, this.store.state.owner!.id);
      if (!snapshot) throw new Error("Only issues authored by the verified numeric owner ID are eligible. Pull requests are excluded.");
      this.observe(snapshot, false);
      this.store.save();
      return this.overview();
    });
  }
  action(key: string, action: "triage" | "retry" | "claim" | "release", note?: string): Promise<Overview> {
    return this.exclusive(async () => {
      const item = this.store.state.items.find((entry) => entry.key === key);
      if (!item) throw new Error("Issue not found.");
      if (action === "claim") {
        if (active(item)) { await this.worker.stop(item.run!); this.fail(item, "Worker stopped for manual ownership."); }
        item.claimed = note?.trim() || "Manually claimed";
        if (item.source === "github") this.store.state.claims[key] = item.claimed;
        item.status = "claimed";
      } else if (action === "release") {
        delete this.store.state.claims[key];
        item.claimed = null;
        item.status = item.snapshot.state === "closed" ? "closed" : item.processedFingerprint === item.snapshot.fingerprint ? "completed" : "discovered";
      } else {
        if (item.claimed) throw new Error("Release the manual claim before triaging this issue.");
        if (active(item) || item.status === "queued") return this.overview();
        if (item.source === "github") {
          this.assertAllowed(item.snapshot.repo);
          this.requireApiReady();
          await this.verifyIdentity();
          const snapshot = await this.github.snapshot(item.snapshot.repo, await this.github.getIssue(item.snapshot.repo, item.snapshot.number), this.store.state.owner!.id);
          if (!snapshot) throw new Error("This issue is no longer eligible for owner-only intake.");
          item.snapshot = snapshot;
          item.unavailable = false;
        }
        if (item.snapshot.state !== "open") throw new Error("Closed issues are not dispatched.");
        if (action === "triage" && item.processedFingerprint === item.snapshot.fingerprint) return this.overview();
        // A failed/uncertain worker must be stopped before a fresh retry can reserve a new ID.
        if (item.run) await this.worker.stop(item.run);
        this.retainRun(item);
        item.status = "queued";
        item.retryRequested = action === "retry";
        item.attempts = 0;
        item.error = null;
        item.retryAt = null;
      }
      item.updatedAt = iso(this.now());
      this.store.save();
      return this.overview();
    });
  }
  /** Explicit, fixed local fixture exercises a real worker without writing to GitHub. */
  diagnostic(action: "run" | "cleanup"): Promise<Overview> {
    return this.exclusive(async () => {
      const existing = this.store.state.items.find((item) => item.source === "diagnostic");
      if (action === "cleanup") {
        if (existing) {
          for (const run of [...existing.history, ...(existing.run ? [existing.run] : [])]) { await this.worker.stop(run); await this.worker.archive(run); }
          this.store.state.items = this.store.state.items.filter((item) => item !== existing);
          this.store.save();
        }
        return this.overview();
      }
      if (existing) return this.overview();
      const text = "Local plugin-test fixture: documentation has a spelling typo. Classify as docs, P3, suggest fixing the typo. Do not use tools.";
      const snapshot: IssueSnapshot = { repo: "local/plugin-test", number: 1, title: "plugin-test: documentation typo", body: text, url: "", authorId: 1, createdAt: iso(this.now()), updatedAt: iso(this.now()), state: "open", comments: [], fingerprint: createHash("sha256").update(text).digest("hex") };
      const item = this.observe(snapshot, false);
      item.source = "diagnostic";
      item.status = "queued";
      this.store.save();
      return this.overview();
    });
  }
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.reconcile();
      const state = this.store.state;
      if (state.config.enabled && this.now() >= state.scan.nextAt) await this.scan();
      if (this.closing || state.items.some(active)) return;
      const item = state.items.find((entry) => entry.status === "queued" && !entry.unavailable && !entry.claimed && (!entry.retryAt || entry.retryAt <= this.now()) && (entry.source === "diagnostic" || (state.config.enabled && state.config.repos.includes(entry.snapshot.repo) && !state.scan.error)));
      if (item) await this.reserve(item);
    });
  }
  private async reserve(item: Item): Promise<void> {
    try {
      let settings = structuredClone(this.store.state.config.worker);
      if (item.source === "github") {
        await this.verifyIdentity();
        const fresh = await this.github.snapshot(item.snapshot.repo, await this.github.getIssue(item.snapshot.repo, item.snapshot.number), this.store.state.owner!.id);
        if (!fresh) { this.fail(item, "Issue no longer belongs to the pinned owner or is a pull request."); this.store.save(); return; }
        item.snapshot = fresh;
        if (fresh.state !== "open") { item.status = "closed"; this.store.save(); return; }
      } else {
        const catalog = await this.worker.catalog();
        const codex = catalog.providers.find((provider) => provider.id === "codex");
        const cheap = ["gpt-5.4-nano", "gpt-5.4-mini", "gpt-6-luna"].map((id) => codex?.models.find((model) => model.id === id)).find(Boolean);
        if (!cheap) throw new Error("No low-cost diagnostic model is available.");
        settings = { provider: "codex", model: cheap.id, modeId: "full-access", thinkingOptionId: cheap.thinking.includes("low") ? "low" : cheap.thinking[0] ?? "", featureValues: {} };
      }
      if (item.snapshot.fingerprint === item.processedFingerprint && !item.retryRequested) {
        item.status = "completed";
        item.error = null;
        item.retryAt = null;
        this.store.save();
        return;
      }
      await this.worker.validate(settings);
      this.retainRun(item);
      const run: Run = { id: randomUUID(), agentId: randomUUID(), fingerprint: item.snapshot.fingerprint, snapshot: structuredClone(item.snapshot), startedAt: iso(this.now()), finishedAt: null, phase: "reserved", result: null, error: null, settings, attempt: item.attempts + 1 };
      item.run = run;
      item.retryRequested = false;
      item.status = "analyzing";
      item.error = null;
      item.retryAt = null;
      item.attempts++;
      item.updatedAt = iso(this.now());
      this.store.save(); // Write-ahead reservation precedes every possible model side effect.
      await this.startRun(item);
    } catch (error) {
      item.error = safeError(error);
      item.retryAt = error instanceof GitHubError ? Math.max(error.retryAt ?? 0, this.now() + backoff(++item.attempts)) : null;
      if (error instanceof GitHubError) this.recordApiFailure(error);
      if (!item.retryAt || item.attempts >= 3) item.status = "failed";
      this.store.save();
    }
  }
  private async startRun(item: Item): Promise<void> {
    if (!item.run) return;
    try {
      await this.worker.start(item.run);
      item.run.phase = "running";
      item.status = "analyzing";
      item.error = null;
      item.retryAt = null;
    } catch (error) {
      const info = error as { retryable?: boolean; uncertain?: boolean };
      item.error = safeError(error);
      if (info.retryable && !info.uncertain && item.attempts < 3) {
        item.retryAt = this.now() + backoff(item.attempts++);
      } else {
        // If stop fails, keep the active reservation. Never dispatch a second worker beside it.
        await this.worker.stop(item.run);
        this.fail(item, item.error);
      }
    }
    this.store.save();
  }
  private async reconcile(): Promise<void> {
    for (const item of this.store.state.items.filter(active)) {
      const run = item.run!;
      try {
        if (this.now() - Date.parse(run.startedAt) >= this.store.state.config.workerTimeoutSeconds * 1000) {
          await this.worker.stop(run);
          this.fail(item, "Worker deadline exceeded. Stopped; manual retry is available.");
        } else if (run.phase === "reserved") {
          if (item.snapshot.state === "closed" || item.claimed || item.unavailable) {
            await this.worker.stop(run);
            this.fail(item, "Reserved issue is no longer dispatchable.");
            if (item.snapshot.state === "closed") item.status = "closed";
            else if (item.claimed) item.status = "claimed";
            this.store.save();
            continue;
          }
          if (item.source === "github" && (!this.store.state.config.enabled || this.store.state.scan.error)) continue;
          if (!item.retryAt || item.retryAt <= this.now()) {
            if (item.source === "github" && !await this.refreshReservation(item)) continue;
            await this.startRun(item);
          }
        } else {
          const outcome = await this.worker.inspect(run);
          if (outcome.status === "completed" && outcome.result) {
            run.phase = "completed";
            run.result = outcome.result;
            run.finishedAt = iso(this.now());
            item.processedFingerprint = run.fingerprint;
            item.error = null;
            item.retryAt = null;
            item.attempts = 0;
            item.status = item.claimed ? "claimed" : item.snapshot.state === "closed" ? "closed" : item.snapshot.fingerprint !== run.fingerprint ? "queued" : "completed";
          } else if (outcome.status === "failed") {
            await this.worker.stop(run);
            this.fail(item, outcome.error ?? "Worker failed.");
          }
        }
        this.workerError = null;
        this.store.save();
      } catch (error) {
        // A transport outage does not release an active lease or start a replacement worker.
        this.workerError = safeError(error);
        if (error instanceof GitHubError) this.recordApiFailure(error);
      }
    }
  }
  /** A reserved retry can run before the next scan; cached eligibility is not enough. */
  private async refreshReservation(item: Item): Promise<boolean> {
    const run = item.run!;
    if (!this.store.state.config.repos.includes(item.snapshot.repo) || !this.store.state.config.repos.includes(run.snapshot.repo)) {
      await this.worker.stop(run);
      this.fail(item, "Repository removed from the allowlist. Reserved worker stopped.");
      this.store.save();
      return false;
    }
    await this.verifyIdentity();
    let fresh: IssueSnapshot | null;
    try {
      const issue = await this.github.getIssue(item.snapshot.repo, item.snapshot.number);
      fresh = await this.github.snapshot(item.snapshot.repo, issue, this.store.state.owner!.id);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      await this.worker.stop(run);
      item.unavailable = true;
      this.fail(item, "Issue is no longer accessible (404). Reserved worker stopped; rediscover it manually after access is restored.");
      this.store.save();
      return false;
    }
    if (!fresh || fresh.state !== "open" || fresh.fingerprint !== run.fingerprint) {
      // A send may already have been attempted. Confirm it has stopped before releasing
      // its identity, and never rewrite the immutable snapshot tied to that send receipt.
      await this.worker.stop(run);
      this.fail(item, !fresh ? "Issue no longer belongs to the pinned owner or is a pull request."
        : fresh.state !== "open" ? "Issue closed before reserved delivery."
          : "Issue changed before reserved delivery; the old reservation was superseded.");
      if (fresh) {
        item.snapshot = fresh;
        item.status = fresh.state === "open" ? "queued" : "closed";
        if (item.status === "queued") { item.attempts = 0; item.error = null; }
      }
      this.store.save();
      return false;
    }
    item.snapshot = fresh;
    this.store.save();
    return true;
  }
  private async scan(): Promise<void> {
    const state = this.store.state;
    this.scanning = true;
    const started = this.now();
    state.scan.lastStartedAt = iso(started);
    this.store.save();
    try {
      await this.verifyIdentity();
      for (const repo of state.config.repos) {
        const issues = await this.github.listIssues(repo, state.scan.cursors[repo]);
        const seen = new Set(issues.map((issue) => issue.number));
        // Comment edits can be missed by issue updated_at. Refresh known open owner issues as well.
        for (const known of state.items.filter((item) => item.source === "github" && item.snapshot.repo === repo && item.snapshot.state === "open" && !item.unavailable && !seen.has(item.snapshot.number))) {
          try { issues.push(await this.github.getIssue(repo, known.snapshot.number)); }
          catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 404) throw error;
            if (active(known)) await this.worker.stop(known.run!);
            known.unavailable = true;
            this.fail(known, "Issue is no longer accessible (404). It may have been deleted or transferred; rediscover it manually after access is restored.");
          }
        }
        for (const issue of issues) await this.observeRaw(repo, issue);
        state.scan.cursors[repo] = iso(started - 60_000); // Overlap protects edits during pagination.
        this.store.save();
      }
      state.scan.lastSucceededAt = iso(this.now());
      state.scan.failures = 0;
      state.scan.error = null;
      state.scan.nextAt = this.now() + state.config.pollSeconds * 1000;
    } catch (error) {
      state.scan.failures++;
      state.scan.error = safeError(error);
      state.scan.nextAt = Math.max(error instanceof GitHubError ? error.retryAt ?? 0 : 0, this.now() + backoff(state.scan.failures));
    } finally { this.scanning = false; this.store.save(); }
  }
  private async observeRaw(repo: string, issue: RawIssue): Promise<void> {
    const snapshot = await this.github.snapshot(repo, issue, this.store.state.owner!.id);
    if (snapshot) this.observe(snapshot, true);
  }
  private observe(snapshot: IssueSnapshot, automatic: boolean): Item {
    snapshot.repo = snapshot.repo.toLowerCase();
    const key = keyOf(snapshot);
    let item = this.store.state.items.find((entry) => entry.key === key);
    const newlyDiscovered = !item;
    const changed = item && item.snapshot.fingerprint !== snapshot.fingerprint;
    if (!item) {
      item = ItemSchema.parse({ key, snapshot, status: "discovered", discoveredAt: iso(this.now()), updatedAt: iso(this.now()), claimed: this.store.state.claims[key] ?? null });
      this.store.state.items.push(item);
    }
    const reopened = item.snapshot.state === "closed" && snapshot.state === "open";
    item.snapshot = snapshot;
    item.unavailable = false;
    if (reopened && !active(item)) item.status = item.processedFingerprint === snapshot.fingerprint ? "completed" : "discovered";
    if (changed) { item.attempts = 0; item.error = null; item.retryAt = null; }
    if (!active(item)) {
      if (item.claimed) item.status = "claimed";
      else if (snapshot.state === "closed") item.status = "closed";
      else if (automatic && (changed || (newlyDiscovered && (this.isNew(snapshot) || this.inBackfill(snapshot))))) item.status = "queued";
    }
    item.updatedAt = iso(this.now());
    return item;
  }
  private isNew(snapshot: IssueSnapshot): boolean { return Boolean(this.store.state.enabledAt && Date.parse(snapshot.createdAt) >= Date.parse(this.store.state.enabledAt)); }
  private inBackfill(snapshot: IssueSnapshot): boolean { return this.store.state.config.backfillDays > 0 && Date.parse(snapshot.createdAt) >= this.now() - this.store.state.config.backfillDays * 86400_000; }
  private retainRun(item: Item): void {
    if (item.run) { item.history = [...item.history, item.run].slice(-10); item.run = null; }
  }
  private fail(item: Item, message: string): void {
    if (item.run) { item.run.phase = "failed"; item.run.error = message; item.run.finishedAt = iso(this.now()); }
    item.status = "failed";
    item.error = message;
    item.retryAt = null;
    item.updatedAt = iso(this.now());
  }
  private async verifyIdentity(): Promise<void> {
    const verified = await this.github.identity();
    const pinned = this.store.state.owner;
    if (pinned && pinned.id !== verified.id) throw new GitHubError("GitHub account changed. Owner-only intake is paused; restore the pinned account.");
    this.store.state.owner = verified;
    this.store.save();
  }
  private assertAllowed(repo: string): void { if (!this.store.state.config.repos.includes(repo.toLowerCase())) throw new Error("Repository is not in the allowlist."); }
  private requireApiReady(): void { if (this.store.state.scan.failures > 0 && this.store.state.scan.nextAt > this.now()) throw new Error("GitHub is in backoff. Wait for the displayed next scan time."); }
  private recordApiFailure(error: GitHubError): void {
    const scan = this.store.state.scan;
    scan.failures++;
    scan.error = error.message;
    scan.nextAt = Math.max(scan.nextAt, error.retryAt ?? 0, this.now() + backoff(scan.failures));
    this.store.save();
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => { if (this.closing) throw new Error("Triage is stopping."); this.store.assertHealthy(); return operation(); }).catch((error) => { if (error instanceof GitHubError) this.recordApiFailure(error); throw error; });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private schedule(delay: number): void {
    if (this.closing) return;
    this.timer = setTimeout(() => {
      void this.tick().catch(() => { this.workerError = "Background operation failed; the next tick will reconcile saved state."; }).finally(() => this.schedule(10_000));
    }, delay);
    this.timer.unref?.();
  }
}

export function prepareWorkspace(dataDirectory: string): string {
  const path = join(dataDirectory, "workspace");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
