// Web Worker wrapper: holds the static grid, runs solve() on request.
import type { StaticGrid } from './grid.ts';
import { solve, type SolveInput } from './solver.ts';
import { runEnsemble } from './metrics.ts';

let grid: StaticGrid | null = null;
let zones: Int32Array[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    grid = m.grid as StaticGrid;
    zones = m.zones ?? [];
    return;
  }
  if (m.type === 'ensemble' && grid) {
    try {
      const res = runEnsemble(grid, m.input as SolveInput, zones, m.n);
      (self as unknown as Worker).postMessage({ type: 'result', id: m.id, res });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'error', id: m.id, error: String(err) });
    }
    return;
  }
  if (m.type === 'solve' && grid) {
    try {
      const res = solve(grid, m.input as SolveInput);
      (self as unknown as Worker).postMessage({ type: 'result', id: m.id, res }, [
        res.arrival.buffer,
        res.ros.buffer,
        res.t0.buffer,
        res.spotted.buffer,
        res.lineT.buffer,
        res.protectT.buffer,
      ]);
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: 'error', id: m.id, error: String(err) });
    }
  }
};
