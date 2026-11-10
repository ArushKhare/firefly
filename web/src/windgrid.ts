// Regional wind field: a coarse lattice of Open-Meteo points over the whole megaregion, so wind is shown
// (and blends into the fire model's own wind) everywhere on the map. Pure, shared by browser and server.
import { REGION } from './zones.ts';

export const WINDGRID = (() => {
  const step = 0.3; // degrees (~30 km): ~160 points
  const pad = 0.3; // one extra ring so the map edges and ocean margin are covered
  const lat0 = REGION.south - pad;
  const lng0 = REGION.west - pad;
  const rows = Math.ceil((REGION.north + pad - lat0) / step) + 1;
  const cols = Math.ceil((REGION.east + pad - lng0) / step) + 1;
  return { step, lat0, lng0, rows, cols };
})();

/** Lattice points, row-major from the south-west corner. */
export function windGridPoints(): { lat: number; lng: number }[] {
  const out: { lat: number; lng: number }[] = [];
  for (let r = 0; r < WINDGRID.rows; r++)
    for (let c = 0; c < WINDGRID.cols; c++) out.push({ lat: +(WINDGRID.lat0 + r * WINDGRID.step).toFixed(3), lng: +(WINDGRID.lng0 + c * WINDGRID.step).toFixed(3) });
  return out;
}

/** Hourly 10 m wind at every lattice point. Times are naive local (America/Los_Angeles) ISO hours. */
export interface WindFieldData {
  times: string[];
  rows: number;
  cols: number;
  u: number[]; // m/s toward east, flat [time][row][col]
  v: number[]; // m/s toward north
}
