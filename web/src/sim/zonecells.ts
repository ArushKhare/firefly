// Which hex zones overlap the model window, and their grid cells. Main thread only (keeps the zone table out of the worker).
import { ZONES, zoneIndexAt, type ZoneDef } from '../zones.ts';
import { type StaticGrid, cellToLatLng } from './grid.ts';

/** Zones that overlap the current grid window, and the grid cells inside each (same order). */
export function zoneCells(g: StaticGrid): { zones: ZoneDef[]; cells: Int32Array[] } {
  const lists = new Map<number, number[]>();
  for (let r = 0; r < g.H; r++) {
    for (let c = 0; c < g.W; c++) {
      const p = cellToLatLng(r, c);
      const k = zoneIndexAt(p.lat, p.lng);
      if (k < 0) continue;
      let l = lists.get(k);
      if (!l) lists.set(k, (l = []));
      l.push(r * g.W + c);
    }
  }
  const keys = [...lists.keys()].sort((a, b) => a - b);
  return { zones: keys.map((k) => ZONES[k]), cells: keys.map((k) => Int32Array.from(lists.get(k)!)) };
}

