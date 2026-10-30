import { readText, SerialQueue, writeJson } from "../files";

interface Reservation { day: string; reserved: number; charged: number | null; status: "reserved" | "settled" }
interface BudgetFile { version: 1; reservations: Record<string, Reservation> }

/** Durable list-price accounting. Unsettled runs remain charged at their maximum after restart. */
export class ReviewBudget {
  private readonly queue = new SerialQueue();
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  private async read(): Promise<BudgetFile> {
    const text = await readText(this.path);
    if (text === null) return { version: 1, reservations: {} };
    const data = JSON.parse(text) as BudgetFile;
    if (data.version !== 1 || !data.reservations || typeof data.reservations !== "object") throw new Error("Review budget ledger is invalid; no model run started.");
    for (const r of Object.values(data.reservations)) {
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !Number.isFinite(r.reserved) || r.reserved < 0 || !["reserved", "settled"].includes(r.status) || (r.charged !== null && (!Number.isFinite(r.charged) || r.charged < 0))) throw new Error("Review budget reservation is invalid; no model run started.");
    }
    return data;
  }

  reserve(id: string, maximum: number, dailyLimit: number): Promise<boolean> {
    return this.queue.run(async () => {
      const data = await this.read();
      if (data.reservations[id]) throw new Error("A run cannot reserve twice.");
      const day = this.now().toISOString().slice(0, 10);
      const used = Object.values(data.reservations).filter(r => r.day === day).reduce((n, r) => n + (r.charged ?? r.reserved), 0);
      if (!Number.isFinite(dailyLimit) || dailyLimit < 0 || !Number.isFinite(maximum) || maximum <= 0 || used + maximum > dailyLimit + 1e-9) return false;
      data.reservations[id] = { day, reserved: maximum, charged: null, status: "reserved" };
      await writeJson(this.path, data);
      return true;
    });
  }

  settle(id: string, actual: number | null): Promise<void> {
    return this.queue.run(async () => {
      const data = await this.read();
      const r = data.reservations[id];
      if (!r || r.status === "settled") return;
      r.charged = actual !== null && Number.isFinite(actual) && actual >= 0 ? actual : r.reserved;
      r.status = "settled";
      await writeJson(this.path, data);
    });
  }

  async today(): Promise<{ day: string; charged: number; reserved: number }> {
    const data = await this.read();
    const day = this.now().toISOString().slice(0, 10);
    const runs = Object.values(data.reservations).filter(r => r.day === day);
    return { day, charged: runs.reduce((n, r) => n + (r.charged ?? 0), 0), reserved: runs.filter(r => r.status === "reserved").reduce((n, r) => n + r.reserved, 0) };
  }
}
