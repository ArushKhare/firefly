// Zone masks, zone ETAs and ensemble (uncertainty) runs. Pure. No DOM.
import type { StaticGrid } from './grid.ts';
import { solve, type SolveInput, type SolveResult } from './solver.ts';
import { weatherAt, type WeatherPoint } from './ros.ts';

export interface ZoneStat {
  arrival: number; // absolute sim minute of first arrival in zone; Infinity if not reached
  pctBurned: number; // 0..100 at time t
}

export function zoneStats(res: SolveResult, cells: Int32Array[], t: number): ZoneStat[] {
  return cells.map((cs) => {
    let first = Infinity;
    let burned = 0;
    for (let k = 0; k < cs.length; k++) {
      const a = res.arrival[cs[k]];
      if (a < first) first = a;
      if (a <= t) burned++;
    }
    return { arrival: first, pctBurned: cs.length ? (100 * burned) / cs.length : 0 };
  });
}

/** Per-zone first-arrival times across ensemble members (absolute minutes, Infinity = not reached). */
export interface EnsembleResult {
  members: number;
  arrivals: number[][]; // [zone][member]
  ms: number;
}

// Perturbations reflect typical forecast error: wind speed +-20 %, direction +-15 deg, dryness +-10 %.
const SPEED = [0.8, 1.2, 0.9, 1.1, 0.85, 1.15, 0.95, 1.05, 1.0, 0.8, 1.2, 1.0];
const DIR = [0, 0, -10, 10, 15, -15, -5, 5, 10, -10, 5, -5];
const DRY = [1.0, 1.0, 1.05, 0.95, 1.1, 0.9, 1.0, 1.0, 0.92, 1.08, 0.95, 1.05];
// urban conflagration uncertainty (few precedents): members span roughly half to 1.7x
const URB = [1.0, 0.6, 1.5, 0.8, 1.25, 0.5, 1.7, 1.0, 0.7, 1.35, 0.9, 1.1];

/** Perturb only the future: keep past points, pin the value at `from`, scale everything after. */
function perturb(ws: WeatherPoint[], from: number, speedK: number, dirD: number): WeatherPoint[] {
  const f = (p: WeatherPoint): WeatherPoint => ({
    ...p,
    speedMps: p.speedMps * speedK,
    gustMps: p.gustMps * speedK,
    fromDeg: (p.fromDeg + dirD + 360) % 360,
  });
  if (!isFinite(from)) return ws.map(f);
  const past = ws.filter((p) => p.atMinute < from);
  const future = ws.filter((p) => p.atMinute > from).map(f);
  return [...past, f({ ...weatherAt(ws, from), atMinute: from }), ...future];
}

export function runEnsemble(g: StaticGrid, base: SolveInput, cells: Int32Array[], n = 12): EnsembleResult {
  const start = performance.now();
  const arrivals: number[][] = cells.map(() => []);
  const freeze = base.freezeT ?? -Infinity;
  for (let m = 0; m < n; m++) {
    const k = m % SPEED.length;
    const input: SolveInput = {
      ...base,
      seed: base.seed + 1000 * (m + 1),
      drynessMult: base.drynessMult * DRY[k],
      urbanMult: (base.urbanMult ?? 1) * URB[k],
      weather: perturb(base.weather, freeze, SPEED[k], DIR[k]),
    };
    const res = solve(g, input);
    cells.forEach((cs, z) => {
      let first = Infinity;
      for (let q = 0; q < cs.length; q++) if (res.arrival[cs[q]] < first) first = res.arrival[cs[q]];
      arrivals[z].push(first);
    });
  }
  return { members: n, arrivals, ms: performance.now() - start };
}

/** Summarise one zone's member arrivals relative to time t. */
export function summarise(arr: number[], t: number): { reached: number; lo: number; mid: number; hi: number } {
  const hit = arr.filter((a) => isFinite(a)).sort((a, b) => a - b);
  if (hit.length === 0) return { reached: 0, lo: Infinity, mid: Infinity, hi: Infinity };
  const q = (p: number) => hit[Math.min(hit.length - 1, Math.max(0, Math.round(p * (hit.length - 1))))] - t;
  return { reached: hit.length / arr.length, lo: q(0.1), mid: q(0.5), hi: q(0.9) };
}
