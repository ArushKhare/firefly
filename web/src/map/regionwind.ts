// Regional wind for the map outside the fire-model area: hourly Open-Meteo wind on a coarse lattice,
// interpolated in space (bilinear) and time (linear). Display only; the fire model uses its own wind.
import { WINDGRID, type WindFieldData } from '../windgrid.ts';

/** "Naive" ms for a local wall time in Los Angeles (same convention as the lattice's local ISO hours). */
export function laNaiveMs(d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
}

export class RegionWind {
  private ms: number[];
  private n: number;
  constructor(
    private d: WindFieldData,
    private t0: number, // naive local ms at sim minute 0
  ) {
    this.ms = d.times.map((t) => Date.parse(t + ':00Z'));
    this.n = d.rows * d.cols;
  }

  /** Wind [east, north] m/s at a point and sim minute. */
  sample(lat: number, lng: number, simMin: number): [number, number] {
    const { d, ms, n } = this;
    const now = this.t0 + simMin * 60000;
    let k = 0;
    while (k < ms.length - 2 && ms[k + 1] <= now) k++;
    const ft = Math.min(1, Math.max(0, (now - ms[k]) / (ms[k + 1] - ms[k] || 1)));
    const fr = Math.min(d.rows - 1.001, Math.max(0, (lat - WINDGRID.lat0) / WINDGRID.step));
    const fc = Math.min(d.cols - 1.001, Math.max(0, (lng - WINDGRID.lng0) / WINDGRID.step));
    const r = Math.floor(fr);
    const c = Math.floor(fc);
    const ar = fr - r;
    const ac = fc - c;
    const at = (arr: number[], kk: number) => {
      const b = kk * n + r * d.cols + c;
      return (arr[b] * (1 - ac) + arr[b + 1] * ac) * (1 - ar) + (arr[b + d.cols] * (1 - ac) + arr[b + d.cols + 1] * ac) * ar;
    };
    return [at(d.u, k) * (1 - ft) + at(d.u, k + 1) * ft, at(d.v, k) * (1 - ft) + at(d.v, k + 1) * ft];
  }
}

export async function loadRegionWind(src: 'live' | 'historical', t0: number): Promise<RegionWind | null> {
  try {
    const r = await fetch(src === 'live' ? '/api/windfield' : '/weather/region_2025-01-07.json', { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as WindFieldData;
    if (!d.times?.length || d.u.length !== d.times.length * d.rows * d.cols) throw new Error('bad wind field');
    return new RegionWind(d, t0);
  } catch (err) {
    console.warn('regional wind unavailable; showing the model wind everywhere', err);
    return null;
  }
}
