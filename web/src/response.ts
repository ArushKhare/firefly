// Fire response & containment (illustrative, not an operational model).
// Resources ramp up with mutual aid; crews/dozers/aircraft build control line at typical production
// rates; line can only be placed on edges calm enough to hold. Containment = held line / perimeter.
// Aircraft are grounded in strong gusts (as on Jan 7 2025). Pure apart from config. No DOM.
import { CELL_M, FUELS, FIREWX, H, NONE, W } from './config.ts';
import { weatherAt, type WeatherPoint } from './sim/ros.ts';

export const RESPONSE = {
  // resources on scene by hours since ignition (linear in between); illustrative numbers
  RAMP: [
    { h: 0, engines: 4, crews: 1, dozers: 0, aircraft: 2 },
    { h: 1, engines: 40, crews: 4, dozers: 2, aircraft: 6 },
    { h: 3, engines: 150, crews: 10, dozers: 6, aircraft: 10 },
    { h: 8, engines: 400, crews: 25, dozers: 12, aircraft: 14 },
    { h: 16, engines: 700, crews: 45, dozers: 20, aircraft: 16 },
    { h: 30, engines: 1100, crews: 80, dozers: 35, aircraft: 20 },
    { h: 48, engines: 1500, crews: 110, dozers: 45, aircraft: 24 },
  ],
  // control line production, km per hour per unit (heavy brush, typical order of magnitude)
  CREW_KMH: 0.1,
  DOZER_KMH: 0.4,
  AIR_KMH: 0.2, // retardant line
  ENGINE_KMH: 0.005, // hose lays; engines mostly protect structures
  // Life safety first: while homes burn or wind is strong, most resources protect structures/evacuations
  LINE_SHARE_CRISIS: 0.12, // dangerous wind: crews pulled off the line
  LINE_SHARE_HOMES: 0.45, // homes burning: engines defend structures, crews/dozers keep cutting line
  LINE_SHARE_NORMAL: 0.6,
  CRISIS_WIND_MS: 10,
  // Line only counts as containment once secured (mopped up, edge out behind it)
  SECURE_FACTOR: 0.25,
  EDGE_MIN_AGE_MIN: 30, // edge must have burned down before crews can work it
  HEAD_STUCK_MIN: 60, // a crew stuck this long repositions to a new anchor
  UNITS_PER_DIVISION: 8, // crews+dozers per line-building division (each works from its own anchor)
  // Line failure: low-intensity fire mostly holds; intense fronts overrun; embers jump lines
  BREACH_MIN: 0.02,
  BREACH_WIND_BONUS: 0.12,
  SPOT_ESCAPE_NORMAL: 0.45, // share of spot fires beyond the line that crews fail to catch
  SPOT_ESCAPE_CRISIS: 0.85,
  HEAD_FACING_COS: 0.35, // no line on edges facing downwind of the fire's centre (unsafe, gets overrun)
  COLD_EDGE_AFTER_MIN: 120, // edge burned out this long (beyond fuel residence) ...
  COLD_EDGE_QUIET_MIN: 360, // ... with no predicted spread from it in this window counts as contained
  ESCAPE_KM: 1, // breaches this close (and within ESCAPE_MIN) are one escape event
  ESCAPE_MIN: 60,
  GROUND_AIR_GUST_MS: 18, // ~40 mph: aircraft grounded
  WIND_EFF_U0: 10, // m/s: line holds less as wind rises (embers jump it)
  WIND_EFF_U1: 20,
  WIND_EFF_MIN: 0.15,
  HOLDABLE_I: 3500, // kW/m: edges above this can't be held with line (dozers/retardant limit)
  STEP_MIN: 10,
};

export interface ResponseState {
  engines: number;
  crews: number;
  dozers: number;
  aircraft: number;
  airGrounded: boolean;
  gustMph: number;
  lineKm: number; // cumulative effective line built
  perimeterKm: number;
  holdableKm: number;
  containmentPct: number;
  contained: Uint8Array; // cells drawn as control line
  breaches: number; // times the fire beat the line so far
  lastBreach: { cell: number; t: number; kind: string } | null;
}

function onScene(hours: number) {
  const R = RESPONSE.RAMP;
  if (hours <= R[0].h) return { ...R[0] };
  for (let k = 0; k + 1 < R.length; k++) {
    const a = R[k];
    const b = R[k + 1];
    if (hours <= b.h) {
      const f = (hours - a.h) / (b.h - a.h);
      return {
        h: hours,
        engines: Math.round(a.engines + (b.engines - a.engines) * f),
        crews: Math.round(a.crews + (b.crews - a.crews) * f),
        dozers: Math.round(a.dozers + (b.dozers - a.dozers) * f),
        aircraft: Math.round(a.aircraft + (b.aircraft - a.aircraft) * f),
      };
    }
  }
  return { ...R[R.length - 1] };
}

/** Number of line-building divisions working at once. */
export function divisions(hours: number): number {
  const r = onScene(hours);
  return 1 + Math.floor((r.crews + r.dozers) / RESPONSE.UNITS_PER_DIVISION);
}

/** Secured control-line production (km/h) for the resources on scene at `hours` after ignition. */
export function lineRateKmh(hours: number, speedMps: number, gustMps: number, homesBurning: boolean): number {
  const r = onScene(hours);
  const share =
    speedMps > RESPONSE.CRISIS_WIND_MS ? RESPONSE.LINE_SHARE_CRISIS : homesBurning ? RESPONSE.LINE_SHARE_HOMES : RESPONSE.LINE_SHARE_NORMAL;
  const grounded = gustMps > RESPONSE.GROUND_AIR_GUST_MS;
  const raw = r.crews * RESPONSE.CREW_KMH + r.dozers * RESPONSE.DOZER_KMH + r.engines * RESPONSE.ENGINE_KMH + (grounded ? 0 : r.aircraft * RESPONSE.AIR_KMH);
  const x = Math.min(1, Math.max(0, (speedMps - RESPONSE.WIND_EFF_U0) / (RESPONSE.WIND_EFF_U1 - RESPONSE.WIND_EFF_U0)));
  return raw * share * RESPONSE.SECURE_FACTOR * (1 - (1 - RESPONSE.WIND_EFF_MIN) * x);
}

/**
 * Chance a held control line fails when fire reaches it. Intense fronts overrun lines; embers that land
 * behind the line start spot fires that crews catch less often when they are stretched thin.
 */
export function breachProbability(intensityKwM: number, windMps: number, spot: boolean, crisis: boolean): number {
  if (spot) return crisis ? RESPONSE.SPOT_ESCAPE_CRISIS : RESPONSE.SPOT_ESCAPE_NORMAL;
  const x = Math.min(1, Math.max(0, (intensityKwM - RESPONSE.HOLDABLE_I) / (3 * RESPONSE.HOLDABLE_I)));
  const wind = windMps > RESPONSE.CRISIS_WIND_MS ? RESPONSE.BREACH_WIND_BONUS : 0;
  return Math.min(0.97, RESPONSE.BREACH_MIN + (0.95 - RESPONSE.BREACH_MIN) * x + wind);
}

/**
 * Group cell-level line breaches into escape events ("slop-overs"): breaches within ESCAPE_KM and
 * ESCAPE_MIN of an earlier one belong to the same escape. Incident reports count escapes, not cells.
 */
export function clusterBreaches<T extends { cell: number; t: number; kind: string }>(breaches: T[]): (T & { cells: number })[] {
  const out: (T & { cells: number })[] = [];
  const sorted = [...breaches].sort((a, b) => a.t - b.t);
  const r2 = (RESPONSE.ESCAPE_KM * 1000) / CELL_M;
  for (const b of sorted) {
    const br = (b.cell / W) | 0;
    const bc = b.cell % W;
    const hit = out.find((e) => b.t - e.t < RESPONSE.ESCAPE_MIN && Math.hypot(((e.cell / W) | 0) - br, (e.cell % W) - bc) < r2);
    if (hit) hit.cells++;
    else out.push({ ...b, cells: 1 });
  }
  return out;
}

/** Panel/map readout from the solver's control lines at time t. */
export function computeResponse(
  res: { arrival: Float32Array; lineT: Float32Array; breaches: { cell: number; t: number; kind: string }[] },
  fuel: Uint8Array,
  blocked: Uint8Array,
  t: number,
  tIgnite: number,
  weather: WeatherPoint[],
): ResponseState {
  const { arrival, lineT } = res;
  let perim = 0;
  let held = 0;
  const contained = new Uint8Array(W * H);
  for (let r = 1; r < H - 1; r++) {
    for (let c = 1; c < W - 1; c++) {
      const i = r * W + c;
      if (!(arrival[i] <= t)) continue;
      let edge = false;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (!(arrival[j] <= t) && !blocked[j] && fuel[j] !== NONE) {
          edge = true;
          break;
        }
      }
      if (!edge) continue;
      perim++;
      if (lineT[i] <= t) {
        held++;
        contained[i] = 1;
        continue;
      }
      // cold edge: flames long gone and the fire isn't predicted to move from here (natural stop,
      // burned out against bare ground / irrigated green); counted the way incident teams do once mopped up
      if (t - arrival[i] > FUELS[fuel[i]].residence + RESPONSE.COLD_EDGE_AFTER_MIN) {
        let quiet = true;
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          const a = arrival[j];
          if (a > t && a <= t + RESPONSE.COLD_EDGE_QUIET_MIN) {
            quiet = false;
            break;
          }
        }
        if (quiet) held++;
      }
    }
  }
  let builtCells = 0;
  for (let i = 0; i < lineT.length; i++) if (lineT[i] <= t) builtCells++;
  const w = weatherAt(weather, t);
  const rs = onScene((t - tIgnite) / 60);
  const breaches = clusterBreaches(res.breaches.filter((b) => b.t <= t));
  return {
    engines: rs.engines,
    crews: rs.crews,
    dozers: rs.dozers,
    aircraft: rs.aircraft,
    airGrounded: w.gustMps > RESPONSE.GROUND_AIR_GUST_MS,
    gustMph: w.gustMps * 2.23694,
    lineKm: (builtCells * CELL_M) / 1000,
    perimeterKm: (perim * CELL_M) / 1000,
    holdableKm: (held * CELL_M) / 1000,
    containmentPct: perim ? (100 * held) / perim : 0,
    contained,
    breaches: breaches.length,
    lastBreach: breaches.length ? breaches[breaches.length - 1] : null,
  };
}
