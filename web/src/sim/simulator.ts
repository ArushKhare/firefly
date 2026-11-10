// Simulator: holds inputs (ignitions, weather, dryness, firebreaks) and the
// latest solved arrival field. Solving happens in a Web Worker. No DOM.
import { FIREWX, HORIZON_MIN, SEED, W, H } from '../config.ts';
import { type LatLng, type StaticGrid, latLngToCell, stampPolylineLatLng } from './grid.ts';
import type { WeatherPoint } from './ros.ts';
import type { Ignition, SolveInput, SolveResult } from './solver.ts';
import type { EnsembleResult } from './metrics.ts';

type Pending = { resolve: (r: unknown) => void; reject: (e: unknown) => void };

/** Shared worker connection; several Simulators (live + what-if clones) can use it. */
export class SolverClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  constructor(grid: StaticGrid, zones: Int32Array[] = []) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.res);
      else p.reject(new Error(m.error));
    };
    this.worker.onerror = (e) => console.error('[worker] error', e.message ?? e);
    this.worker.onmessageerror = (e) => console.error('[worker] message error', e);
    this.worker.postMessage({ type: 'init', grid, zones });
  }
  private call<T>(type: string, payload: object): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.worker.postMessage({ type, id, ...payload });
    });
  }
  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('solver replaced'));
    this.pending.clear();
  }
  solve(input: SolveInput): Promise<SolveResult> {
    return this.call<SolveResult>('solve', { input });
  }
  ensemble(input: SolveInput, n: number): Promise<EnsembleResult> {
    return this.call<EnsembleResult>('ensemble', { input, n });
  }
}

export class Simulator {
  ignitions: Ignition[] = [];
  weather: WeatherPoint[] = [];
  dryness = 1;
  fireWx = FIREWX.ENABLED;
  urbanMult = 1;
  airAttack = true; // aircraft drop retardant / water
  clockStartMin = 12 * 60; // local time of day at sim minute 0 (aircraft fly by day)
  firebreak: Uint8Array;
  firebreakPaths: { path: LatLng[]; widthM: number }[] = [];
  result: SolveResult | null = null;
  simTime = 0;
  seed = SEED;
  private computeSeq = 0;

  constructor(
    readonly grid: StaticGrid,
    private client: SolverClient,
  ) {
    this.firebreak = new Uint8Array(W * H);
  }

  reset(): void {
    this.ignitions = [];
    this.result = null;
    this.simTime = 0;
    this.firebreak.fill(0);
    this.firebreakPaths = [];
  }

  /** Returns number of cells ignited (0 if all points were unburnable). */
  ignite(points: LatLng[], atMinute = this.simTime): number {
    let k = 0;
    for (const p of points) {
      const rc = latLngToCell(p.lat, p.lng);
      if (!rc) continue;
      const cell = this.nearestBurnable(rc.r, rc.c, 6);
      if (cell < 0) continue;
      this.ignitions.push({ cell, t: atMinute });
      k++;
    }
    return k;
  }

  /** Nearest cell that can burn (vegetation preferred over city), within maxR cells; -1 if none. */
  private nearestBurnable(r0: number, c0: number, maxR: number): number {
    const { fuel, blocked } = this.grid;
    let best = -1;
    let bestScore = Infinity;
    for (let dr = -maxR; dr <= maxR; dr++) {
      for (let dc = -maxR; dc <= maxR; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= H || c < 0 || c >= W) continue;
        const i = r * W + c;
        if (blocked[i] || fuel[i] === 0) continue;
        const score = dr * dr + dc * dc + (fuel[i] === 5 ? 50 : 0); // avoid starting in dense city
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    return best;
  }

  setWindSchedule(ws: WeatherPoint[]): void {
    this.weather = ws;
  }

  setDryness(x: number): void {
    this.dryness = x;
  }

  addFirebreak(path: LatLng[], widthM = 60): void {
    stampPolylineLatLng(this.firebreak, path, widthM);
    this.firebreakPaths.push({ path, widthM });
  }

  private blockedMask(): Uint8Array {
    const b = new Uint8Array(this.grid.blocked);
    for (let i = 0; i < b.length; i++) if (this.firebreak[i]) b[i] = 1;
    return b;
  }

  /** Re-solve from the current sim time, keeping everything already burned. */
  async compute(horizonMin = HORIZON_MIN): Promise<boolean> {
    if (this.ignitions.length === 0 || this.weather.length === 0) {
      this.result = null;
      return true;
    }
    const seq = ++this.computeSeq;
    const res = await this.client.solve(this.buildInput(horizonMin));
    if (seq !== this.computeSeq) return false; // superseded by a newer compute
    this.result = res;
    return true;
  }

  /** Uncertainty runs from the same state (needs a solved live result). */
  async ensemble(client: SolverClient, n = 12, horizonMin = HORIZON_MIN): Promise<EnsembleResult | null> {
    if (!this.result || this.ignitions.length === 0) return null;
    return client.ensemble(this.buildInput(horizonMin, true), n);
  }

  /** forceFreeze: freeze at simTime against the current result (ensemble members). */
  private buildInput(horizonMin: number, forceFreeze = false): SolveInput {
    const canFreeze = !!this.result && (this.simTime > 0 || forceFreeze);
    const freeze = canFreeze ? this.simTime : undefined;
    return {
      ignitions: this.ignitions.filter((ig) => freeze === undefined || ig.t >= freeze),
      weather: this.weather,
      drynessMult: this.dryness,
      fireWx: this.fireWx,
      firstIgnitionT: this.ignitions.length ? Math.min(...this.ignitions.map((x) => x.t)) : undefined,
      urbanMult: this.urbanMult,
      airAttack: this.airAttack,
      clockStartMin: this.clockStartMin,
      seed: this.seed,
      horizon: this.simTime + horizonMin,
      blocked: this.blockedMask(),
      freezeT: freeze,
      prev: freeze !== undefined && this.result ? this.result : undefined,
    };
  }

  clone(): Simulator {
    const s = new Simulator(this.grid, this.client);
    s.ignitions = this.ignitions.map((x) => ({ ...x }));
    s.weather = this.weather.map((x) => ({ ...x }));
    s.dryness = this.dryness;
    s.fireWx = this.fireWx;
    s.urbanMult = this.urbanMult;
    s.airAttack = this.airAttack;
    s.clockStartMin = this.clockStartMin;
    s.firebreak = new Uint8Array(this.firebreak);
    s.firebreakPaths = this.firebreakPaths.map((f) => ({ path: [...f.path], widthM: f.widthM }));
    s.result = this.result;
    s.simTime = this.simTime;
    s.seed = this.seed;
    return s;
  }
}
