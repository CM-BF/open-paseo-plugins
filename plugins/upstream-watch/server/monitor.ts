import { randomUUID } from "node:crypto";
import { type State, type Watch, type WatchDraft } from "../shared/contracts";
import { GitHubClient, GitHubError } from "./github";
import { Store } from "./store";
import { configurationKey, normalizeDraft } from "./validation";
import { reviewKey } from "./review-context";

export const OBSERVATION_MAX_AGE = 24 * 60 * 60 * 1000;

export class Monitor {
  private flight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly controller = new AbortController();
  private disposed = false;
  private scheduleGeneration = 0;
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly afterCheck?: (watch: Watch) => Promise<void>;

  constructor(
    readonly store: Store,
    readonly github: GitHubClient,
    options: {
      now?: () => number;
      afterCheck?: (watch: Watch) => Promise<void>;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.afterCheck = options.afterCheck;
  }
  get checking(): boolean {
    return Boolean(this.flight);
  }

  async save(input: WatchDraft): Promise<Watch> {
    const draft = normalizeDraft(input);
    const watch = await this.store.change((state) => {
      const previous = draft.id
        ? state.watches.find((watch) => watch.id === draft.id)
        : undefined;
      if (draft.id && !previous)
        throw new Error("Watch no longer exists. Reload before saving.");
      if (!previous && state.watches.length >= 100)
        throw new Error("At most 100 watches are supported.");
      const date = new Date(this.now()).toISOString();
      const next: Watch = {
        ...draft,
        id: previous?.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? date,
        updatedAt: date,
      };
      const sourceKey = (watch: Watch) =>
        JSON.stringify([
          watch.repository,
          watch.ref,
          watch.paths,
          watch.baseline,
        ]);
      if (previous && sourceKey(previous) === sourceKey(next)) {
        next.checkedAt = previous.checkedAt;
        next.error = previous.error;
        next.retryAt = previous.retryAt;
        next.observation = previous.observation;
        if (
          reviewKey(previous, previous.reviewState?.localRevision) ===
          reviewKey(next, previous.reviewState?.localRevision)
        )
          next.reviewState = previous.reviewState;
      }
      if (previous)
        state.watches[
          state.watches.findIndex((watch) => watch.id === previous.id)
        ] = next;
      else state.watches.push(next);
      return next;
    });
    this.generations.set(watch.id, (this.generations.get(watch.id) ?? 0) + 1);
    return watch;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.store.change((state) => {
      const index = state.watches.findIndex((watch) => watch.id === id);
      if (index < 0) return false;
      state.watches.splice(index, 1);
      return true;
    });
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    return removed;
  }

  async acknowledge(id: string, exactHead: string): Promise<Watch> {
    const updated = await this.store.change((state) => {
      const watch = state.watches.find((watch) => watch.id === id);
      if (!watch) throw new Error("Watch no longer exists.");
      const checked = Date.parse(watch.checkedAt ?? "");
      if (
        watch.error ||
        !watch.observation ||
        !Number.isFinite(checked) ||
        checked > this.now() ||
        this.now() - checked > OBSERVATION_MAX_AGE
      ) {
        throw new Error(
          "Check this upstream successfully again before marking it handled.",
        );
      }
      if (watch.observation.head !== exactHead)
        throw new Error(
          "Upstream head changed. Reload and review the current result.",
        );
      watch.baseline = exactHead;
      watch.updatedAt = new Date(this.now()).toISOString();
      watch.error = undefined;
      watch.retryAt = undefined;
      watch.observation = {
        ...watch.observation,
        compareUrl: watch.observation.url,
        comparison: "identical",
        commits: [],
        commitsTotal: 0,
        files: [],
        filesTruncated: false,
        matchedPaths: [],
        hasUpdate: false,
        needsReview: false,
      };
      return watch;
    });
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    return updated;
  }

  check(id?: string): boolean {
    return this.start(id, false);
  }

  private start(id: string | undefined, dueOnly: boolean): boolean {
    if (this.disposed || this.flight) return false;
    this.flight = this.run(id, dueOnly)
      .catch((error) => {
        // Store failures remain visible through read/RPC; do not print state or transport details.
        console.error(
          "[upstream-watch] Check could not finish:",
          error instanceof Error &&
            error.message.startsWith("Upstream Watch state")
            ? error.message
            : "state operation failed",
        );
      })
      .finally(() => {
        this.flight = undefined;
        if (!this.disposed) this.schedule();
      });
    return true;
  }

  async waitForIdle(): Promise<void> {
    await this.flight;
  }

  private dueAt(watch: Watch, state: State): number {
    const checked = Date.parse(watch.checkedAt ?? "");
    const retry = Date.parse(watch.retryAt ?? "");
    return Math.max(
      Number.isFinite(checked)
        ? checked + state.settings.intervalHours * 60 * 60 * 1000
        : this.now(),
      Number.isFinite(retry) ? retry : 0,
    );
  }

  private currentWatch(
    state: State,
    id: string,
    key: string,
    generation: number,
    dueOnly: boolean,
  ): Watch | undefined {
    if (dueOnly && !state.settings.enabled) return;
    const watch = state.watches.find((watch) => watch.id === id);
    if (
      !watch?.enabled ||
      configurationKey(watch) !== key ||
      (this.generations.get(id) ?? 0) !== generation
    )
      return;
    return watch;
  }

  private async run(id: string | undefined, dueOnly: boolean): Promise<void> {
    const state = await this.store.read();
    if (dueOnly && !state.settings.enabled) return;
    for (const snapshot of state.watches.filter(
      (watch) =>
        watch.enabled &&
        (!id || watch.id === id) &&
        (!dueOnly || this.dueAt(watch, state) <= this.now()),
    )) {
      if (this.disposed) return;
      const key = configurationKey(snapshot);
      const generation = this.generations.get(snapshot.id) ?? 0;
      // A batch can wait on the network while later entries are paused, removed or edited.
      const latest = await this.store.read();
      if (this.disposed || (dueOnly && !latest.settings.enabled)) return;
      const pending = this.currentWatch(
        latest,
        snapshot.id,
        key,
        generation,
        dueOnly,
      );
      if (
        !pending ||
        (dueOnly && this.dueAt(pending, latest) > this.now()) ||
        (pending.retryAt && Date.parse(pending.retryAt) > this.now())
      )
        continue;
      try {
        const observation = await this.github.observe(
          snapshot,
          this.controller.signal,
        );
        if (this.disposed) return;
        if (
          !this.currentWatch(
            await this.store.read(),
            snapshot.id,
            key,
            generation,
            dueOnly,
          )
        )
          continue;
        const observed = await this.store.change((current) => {
          const watch = this.currentWatch(
            current,
            snapshot.id,
            key,
            generation,
            dueOnly,
          );
          if (!watch) return;
          if (!watch.baseline) watch.baseline = observation.head;
          watch.observation = observation;
          watch.checkedAt = new Date(this.now()).toISOString();
          watch.error = undefined;
          watch.retryAt = undefined;
          return watch;
        });
        if (observed && !this.disposed && this.afterCheck) {
          await this.afterCheck(observed).catch(() => {
            console.error(
              "[upstream-watch] Review preparation failed; no automatic retry was sent.",
            );
          });
        }
      } catch (error) {
        if (this.disposed) return;
        if (
          !this.currentWatch(
            await this.store.read(),
            snapshot.id,
            key,
            generation,
            dueOnly,
          )
        )
          continue;
        await this.store.change((current) => {
          const watch = this.currentWatch(
            current,
            snapshot.id,
            key,
            generation,
            dueOnly,
          );
          if (!watch) return;
          watch.error =
            error instanceof GitHubError
              ? error.message
              : "GitHub check failed. The previous successful result was retained.";
          watch.checkedAt = new Date(this.now()).toISOString();
          watch.retryAt =
            error instanceof GitHubError ? error.retryAt : undefined;
        });
      }
    }
  }

  schedule(): void {
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.store
      .read()
      .then((state) => {
        if (
          this.disposed ||
          generation !== this.scheduleGeneration ||
          !state.settings.enabled
        )
          return;
        const dueTimes = state.watches
          .filter((watch) => watch.enabled)
          .map((watch) => this.dueAt(watch, state));
        if (!dueTimes.length) return;
        const next = Math.min(...dueTimes);
        if (next <= this.now()) {
          if (!this.start(undefined, true) && this.flight) {
            void this.flight.then(() => {
              if (generation === this.scheduleGeneration) this.schedule();
            });
          }
          return;
        }
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.schedule();
          },
          Math.max(1, next - this.now()),
        );
        (this.timer as unknown as { unref?: () => void }).unref?.();
      })
      .catch(() =>
        console.error(
          "[upstream-watch] Schedule unavailable: invalid or unreadable state.",
        ),
      );
  }

  dispose(): void {
    this.disposed = true;
    this.scheduleGeneration++;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
