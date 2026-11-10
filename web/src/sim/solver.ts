// Event-driven arrival-time solver (minimum travel time) with time-varying
// weather, ellipse spread, slope, acceleration and ember spotting. Pure. No DOM.
import { FIREWX, FUELS, NONE, PHYS, URBAN } from '../config.ts';
import type { StaticGrid } from './grid.ts';
import { buildEnvTable, directionalRate, eccentricity, gustSeries, headRates, type WeatherPoint } from './ros.ts';
import { FireTracker, fireWindAt, updateFireWx, type FireWxSample } from './firewx.ts';
import { AIR, DROP_RETARDANT, DROP_WATER, RESPONSE, aircraftFlying, breachProbability, divisions, dropLife, isDaylight, lineRateKmh } from '../response.ts';
import { rand3 } from './terrain.ts';

export interface Ignition {
  cell: number;
  t: number;
}

export interface SolveInput {
  ignitions: Ignition[];
  weather: WeatherPoint[];
  drynessMult: number;
  seed: number;
  horizon: number; // absolute sim minute to stop at
  blocked: Uint8Array; // static blocked | firebreaks
  // Mid-run recompute: cells with prev.arrival <= freezeT are kept as-is.
  freezeT?: number;
  prev?: {
    arrival: Float32Array;
    ros: Float32Array;
    t0: Float32Array;
    spotted: Uint8Array;
    fireWx?: FireWxSample[];
    lineT?: Float32Array;
    protectT?: Float32Array;
    breaches?: BreachEvent[];
    retT?: Float32Array;
    retKind?: Uint8Array;
    drops?: DropEvent[];
  };
  firstIgnitionT?: number; // first ignition of the incident (resources ramp from here)
  containment?: boolean; // firefighters build control line that can stop the fire (default true)
  fireWx?: boolean; // fire-generated weather + gust noise (default FIREWX.ENABLED)
  suppression?: boolean; // firefighting on low-intensity edges (default PHYS.SUPPRESS_ON)
  urbanMult?: number; // structure-fire spread multiplier (uncertain; default 1)
  airAttack?: boolean; // aircraft drop retardant / water ahead of the fire (default true)
  clockStartMin?: number; // local time of day at sim minute 0, minutes after midnight (aircraft fly by day)
}

/** One air drop: a line of retardant (air tanker) or water (helicopter) from (r0,c0) to (r1,c1). */
export interface DropEvent {
  t: number;
  kind: number; // DROP_RETARDANT | DROP_WATER
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface BreachEvent {
  cell: number;
  t: number;
  kind: 'overrun' | 'spot';
}

export interface WhirlEvent {
  cell: number;
  t: number;
}

export interface SpotEvent {
  from: number;
  to: number;
  tLaunch: number;
  tLand: number;
}

export interface SolveResult {
  arrival: Float32Array; // sim minute fire arrives; Infinity if never
  ros: Float32Array; // m/min when it arrived
  t0: Float32Array; // ignition time of the fire that reached this cell (for acceleration)
  spotted: Uint8Array; // 1 if ignited by an ember
  spots: SpotEvent[];
  whirls: WhirlEvent[];
  lineT: Float32Array; // burned edge cell held by control line from this time (Infinity = never)
  protectT: Float32Array; // unburned cell behind a control line from this time
  breaches: BreachEvent[]; // fire beat the line: overran it or spotted across
  retT: Float32Array; // time an air drop coated this cell (Infinity = never)
  retKind: Uint8Array; // DROP_RETARDANT | DROP_WATER (0 = none)
  drops: DropEvent[];
  fireWx: FireWxSample[]; // fire-weather timeline, one sample per FIREWX.STATE_DT minutes
  horizon: number;
  ms: number;
}

// 16-neighbour stencil: removes the square/diamond artifacts of 4/8-neighbour grids.
const STENCIL: [number, number][] = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-1, -2], [-1, 2], [1, -2], [1, 2],
  [-2, -1], [-2, 1], [2, -1], [2, 1],
];

class MinHeap {
  t = new Float64Array(1 << 16);
  v = new Int32Array(1 << 16);
  size = 0;
  push(t: number, v: number): void {
    if (this.size === this.t.length) {
      const nt = new Float64Array(this.size * 2);
      nt.set(this.t);
      this.t = nt;
      const nv = new Int32Array(this.size * 2);
      nv.set(this.v);
      this.v = nv;
    }
    let i = this.size++;
    const T = this.t;
    const V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (T[p] <= t) break;
      T[i] = T[p];
      V[i] = V[p];
      i = p;
    }
    T[i] = t;
    V[i] = v;
  }
  /** Pops the min; returns its value, time in this.lastT. */
  lastT = 0;
  pop(): number {
    const T = this.t;
    const V = this.v;
    const topV = V[0];
    this.lastT = T[0];
    const n = --this.size;
    if (n > 0) {
      const t = T[n];
      const v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && T[c + 1] < T[c]) c++;
        if (T[c] >= t) break;
        T[i] = T[c];
        V[i] = V[c];
        i = c;
      }
      T[i] = t;
      V[i] = v;
    }
    return topV;
  }
}

export function solve(g: StaticGrid, inp: SolveInput): SolveResult {
  const start = performance.now();
  const { W, H, cellM, fuel, elev, hetero, road } = g;
  const windExp = g.windExp;
  const structMult = g.structMult;
  const urbanMult = inp.urbanMult ?? 1;
  const structK = (j: number) => urbanMult * (structMult ? structMult[j] : 1);
  const breach = PHYS.ROAD_BREACH_ROS;
  const blocked = inp.blocked;
  const n = W * H;
  const freezeT = inp.freezeT ?? -Infinity;
  const horizon = inp.horizon;

  const arrival = new Float32Array(n).fill(Infinity);
  const ros = new Float32Array(n);
  const t0 = new Float32Array(n);
  const spotted = new Uint8Array(n);
  const done = new Uint8Array(n);
  const spots: SpotEvent[] = [];
  const heap = new MinHeap();

  // Env lookup per sim minute
  const tStart = 0;
  const weatherGust = (t: number) => {
    // gust from the schedule (for grounding aircraft); nearest earlier point is fine here
    let g = inp.weather[0]?.gustMps ?? 0;
    for (const p of inp.weather) if (p.atMinute <= t) g = p.gustMps;
    return g;
  };
  const wxOn = inp.fireWx ?? FIREWX.ENABLED;
  const suppressOn = inp.suppression ?? PHYS.SUPPRESS_ON;
  const gusts = wxOn ? gustSeries(inp.seed, horizon + 2, FIREWX.GUST_SIGMA_SPEED, FIREWX.GUST_SIGMA_DIR_DEG, FIREWX.GUST_TAU_MIN) : undefined;
  const envs = buildEnvTable(inp.weather, tStart, Math.ceil(horizon) + 1, inp.drynessMult, gusts);
  const envIdx = (t: number) => Math.min(envs.length - 1, Math.max(0, Math.floor(t) - tStart));

  // Stencil geometry
  const K = STENCIL.length;
  const sDr = new Int32Array(K);
  const sDc = new Int32Array(K);
  const sDist = new Float64Array(K);
  const sUe = new Float64Array(K);
  const sUn = new Float64Array(K);
  // intermediate cells to check for leaking through blocked lines
  const sMidA = new Int32Array(K);
  const sMidB = new Int32Array(K);
  const sMode = new Uint8Array(K); // 0 ortho, 1 diagonal (skip if both mids blocked), 2 knight (skip if either)
  for (let k = 0; k < K; k++) {
    const [dr, dc] = STENCIL[k];
    sDr[k] = dr;
    sDc[k] = dc;
    const len = Math.hypot(dr, dc);
    sDist[k] = len * cellM;
    sUe[k] = dc / len;
    sUn[k] = -dr / len;
    if (Math.abs(dr) === 1 && Math.abs(dc) === 1) {
      sMode[k] = 1;
      sMidA[k] = dr * W; // (dr, 0)
      sMidB[k] = dc; // (0, dc)
    } else if (Math.abs(dr) + Math.abs(dc) === 3) {
      sMode[k] = 2;
      if (Math.abs(dr) === 2) {
        // (2,1): passes (1,0) and (1,1)
        sMidA[k] = (dr / 2) * W;
        sMidB[k] = (dr / 2) * W + dc;
      } else {
        // (1,2): passes (0,1) and (1,1)
        sMidA[k] = dc / 2;
        sMidB[k] = dr * W + dc / 2;
      }
    }
  }

  // ---- Seed from previous result (mid-run recompute) ----
  if (inp.prev && freezeT > -Infinity) {
    const P = inp.prev;
    for (let i = 0; i < n; i++) {
      if (P.arrival[i] <= freezeT && !blocked[i]) {
        arrival[i] = P.arrival[i];
        ros[i] = P.ros[i];
        t0[i] = P.t0[i];
        spotted[i] = P.spotted[i];
        done[i] = 1;
      }
    }
    // Re-open front cells (burned cells touching an unburned, burnable cell)
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        if (!done[i]) continue;
        let front = false;
        for (let dr = -1; dr <= 1 && !front; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
            const j = rr * W + cc;
            if (!done[j] && !blocked[j] && fuel[j] !== NONE) {
              front = true;
              break;
            }
          }
        }
        if (front) {
          done[i] = 0;
          heap.push(arrival[i], i);
        }
      }
    }
  }

  // ---- Fire-weather state ----
  const tracker = new FireTracker();
  const wxTimeline: FireWxSample[] = [];
  let wx: FireWxSample | null = null;
  const STATE_DT = FIREWX.STATE_DT;
  let nextTick = -Infinity; // set on first pop
  const loadHI = FUELS.map((f) => f.load * FIREWX.HEAT_CONTENT); // kJ/m2 -> I = loadHI * R(m/s)
  if (inp.prev && freezeT > -Infinity) {
    // Rebuild the recent-ignition window and keep the timeline up to freezeT
    const recent: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!(arrival[i] <= freezeT)) continue;
      tracker.totalCells++;
      if (arrival[i] > freezeT - FIREWX.WINDOW_MIN) recent.push(i);
    }
    tracker.totalCells -= recent.length; // push() counts them again
    recent.sort((a, b) => arrival[a] - arrival[b]);
    for (const i of recent) {
      const R = ros[i] / 60;
      tracker.push(arrival[i], (i / W) | 0, i % W, loadHI[fuel[i]] * R, R);
    }
    for (const s of inp.prev.fireWx ?? []) if (s.t <= freezeT) wxTimeline.push(s);
    wx = wxTimeline.length ? wxTimeline[wxTimeline.length - 1] : null;
    nextTick = (Math.floor(freezeT / STATE_DT) + 1) * STATE_DT;
  }

  // ---- Containment: control line built during the run (oldest calm edges first) ----
  const containOn = inp.containment ?? true;
  const lineT = new Float32Array(n).fill(Infinity);
  const protectT = new Float32Array(n).fill(Infinity);
  const src = new Int32Array(n).fill(-1); // cell whose fire set this cell's arrival (-1 = ignition/frozen)
  const breaches: BreachEvent[] = [];
  if (inp.prev && freezeT > -Infinity) {
    if (inp.prev.lineT) for (let i = 0; i < n; i++) if (inp.prev.lineT[i] <= freezeT) lineT[i] = inp.prev.lineT[i];
    if (inp.prev.protectT) for (let i = 0; i < n; i++) if (inp.prev.protectT[i] <= freezeT) protectT[i] = inp.prev.protectT[i];
    for (const b of inp.prev.breaches ?? []) if (b.t <= freezeT) breaches.push(b);
  }
  const tFirst = inp.firstIgnitionT ?? Math.min(freezeT === -Infinity ? Infinity : freezeT, ...inp.ignitions.map((x) => x.t));
  const popOrder: number[] = []; // cells in ignition order (line goes on the oldest edges first)
  let popPtr = 0;
  let budgetCells = 0;
  const structPops: number[] = []; // times homes caught fire (life-safety priority)
  let structPtr = 0;
  const homesBurningAt = (t: number) => {
    while (structPtr < structPops.length && structPops[structPtr] < t - 60) structPtr++;
    return structPops.length - structPtr > 3;
  };
  // Anchor-and-flank: two line heads start at the heel (oldest calm edge) and cut along the fire edge in
  // opposite directions, as fast as resources allow; a head waits where the edge is too hot or too fresh.
  const heads: number[] = [];
  const stuckSince: number[] = []; // sim minute each head got stuck (Infinity = moving)
  let lastSweep = -Infinity;
  const isOpen = (j: number, t: number) => !(arrival[j] <= t) && !blocked[j] && fuel[j] !== NONE && protectT[j] === Infinity;
  // edge = burned cell next to unburned fuel (protected or not: the crew keeps following the fire edge)
  const isEdge = (i: number, t: number) => {
    const ri = (i / W) | 0;
    const ci = i - ri * W;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = ri + dr;
        const cc = ci + dc;
        if (!(dr || dc) || rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const j = rr * W + cc;
        if (!(arrival[j] <= t) && !blocked[j] && fuel[j] !== NONE) return true;
      }
    return false;
  };
  // workable edge: burned down enough for crews, and either low-intensity or long burned out
  // (the intense front that passed here has moved on; what's left is a cold, workable edge)
  const workable = (i: number, t: number) => {
    const age = t - arrival[i];
    if (age < RESPONSE.EDGE_MIN_AGE_MIN) return false;
    return loadHI[fuel[i]] * (ros[i] / 60) <= RESPONSE.HOLDABLE_I || age >= FUELS[fuel[i]].residence + 60;
  };
  const cutLine = (i: number, t: number) => {
    const ri = (i / W) | 0;
    const ci = i - ri * W;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = ri + dr;
        const cc = ci + dc;
        if ((dr || dc) && rr >= 0 && rr < H && cc >= 0 && cc < W && isOpen(rr * W + cc, t)) protectT[rr * W + cc] = t;
      }
    lineT[i] = t;
  };
  /** Next unlined edge cell next to a head (search radius 2 so small gaps don't stop the crew). */
  const nextAlong = (h: number, t: number): number => {
    const ri = (h / W) | 0;
    const ci = h - ri * W;
    let best = -1;
    let bestA = Infinity;
    for (let rad = 1; rad <= 2 && best < 0; rad++)
      for (let dr = -rad; dr <= rad; dr++)
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const rr = ri + dr;
          const cc = ci + dc;
          if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
          const j = rr * W + cc;
          if (!(arrival[j] <= t) || lineT[j] < Infinity || !isEdge(j, t)) continue;
          if (arrival[j] < bestA) ((bestA = arrival[j]), (best = j));
        }
    return best;
  };
  const buildLine = (t: number, U10: number, gust: number) => {
    if (!containOn || !isFinite(tFirst)) return;
    budgetCells += ((lineRateKmh((t - tFirst) / 60, U10, homesBurningAt(t)) * STATE_DT) / 60) * (1000 / cellM);
    let guard = 0;
    const maxHeads = 2 * divisions((t - tFirst) / 60);
    while (budgetCells >= 1 && guard++ < 5000) {
      if (heads.length < maxHeads) {
        // (re-)anchor at the oldest workable edge cell
        let anchor = -1;
        while (popPtr < popOrder.length) {
          const i = popOrder[popPtr];
          if (arrival[i] > t - RESPONSE.EDGE_MIN_AGE_MIN) break;
          popPtr++;
          if (lineT[i] === Infinity && isEdge(i, t) && workable(i, t)) {
            anchor = i;
            break;
          }
        }
        // every sim hour, revisit edges skipped earlier (too hot then, workable now)
        if (anchor < 0 && t - lastSweep >= 60) {
          for (let q = 0; q < popPtr; q++) {
            const i = popOrder[q];
            if (lineT[i] === Infinity && workable(i, t) && isEdge(i, t)) {
              anchor = i;
              break;
            }
          }
          if (anchor < 0) lastSweep = t; // nothing left to revisit this hour
        }
        if (anchor < 0) {
          if (heads.length === 0) break; // nothing workable yet
        } else {
          cutLine(anchor, t);
          budgetCells -= 1;
          heads.push(anchor, anchor);
          stuckSince.push(Infinity, Infinity);
          continue;
        }
      }
      if (heads.length === 0) break;
      let progressed = false;
      for (let k = heads.length - 1; k >= 0 && budgetCells >= 1; k--) {
        const nx = nextAlong(heads[k], t);
        if (nx < 0 || t - stuckSince[k] > RESPONSE.HEAD_STUCK_MIN) {
          heads.splice(k, 1); // dead end (barrier / line closed) or stuck too long: crew repositions
          stuckSince.splice(k, 1);
          continue;
        }
        if (!workable(nx, t)) {
          if (stuckSince[k] === Infinity) stuckSince[k] = t; // too hot / too fresh: crew holds here
          continue;
        }
        cutLine(nx, t);
        heads[k] = nx;
        stuckSince[k] = Infinity;
        budgetCells -= 1;
        progressed = true;
      }
      if (!progressed) break;
    }
    budgetCells = Math.min(budgetCells, 200); // don't bank unlimited line while waiting
  };

  // ---- Air attack: retardant / water drops just ahead of the fire edge ----
  const airOn = inp.airAttack ?? true;
  const clock0 = inp.clockStartMin ?? 12 * 60;
  const retT = new Float32Array(n).fill(Infinity);
  const retKind = new Uint8Array(n);
  const drops: DropEvent[] = [];
  if (inp.prev && freezeT > -Infinity) {
    const P = inp.prev;
    if (P.retT && P.retKind) for (let i = 0; i < n; i++) if (P.retT[i] <= freezeT) ((retT[i] = P.retT[i]), (retKind[i] = P.retKind[i]));
    for (const d of P.drops ?? []) if (d.t <= freezeT) drops.push(d);
  }
  const coated = (j: number, t: number) => retT[j] <= t && t - retT[j] < dropLife(retKind[j]);
  let dropBudget = 0;
  const offCells = AIR.OFFSET_M / cellM;
  const lookCells = Math.round(AIR.LOOKAHEAD_M / cellM);
  /** Pick the most useful edge and lay one drop line just ahead of it. False if no target. */
  const placeDrop = (t: number, kind: number): boolean => {
    // candidate edge cells: burned in the last 45 min, still next to unburned fuel
    const cand: number[] = [];
    for (let q = popOrder.length - 1; q >= 0 && cand.length < 600; q--) {
      const i = popOrder[q];
      if (arrival[i] < t - 45) break;
      if (isEdge(i, t)) cand.push(i);
    }
    if (!cand.length) return false;
    // fire centre: heat centre from fire weather, else the centroid of the candidates
    let cr = 0;
    let cc = 0;
    if (wx) ((cr = wx.heatR), (cc = wx.heatC));
    else {
      for (const i of cand) ((cr += (i / W) | 0), (cc += i % W));
      ((cr /= cand.length), (cc /= cand.length));
    }
    let best = -1;
    let bestS = -Infinity;
    let bu = 0;
    let bv = 0;
    const tries = Math.min(40, cand.length);
    for (let k = 0; k < tries; k++) {
      const i = cand[Math.floor(rand3(inp.seed, drops.length * 64 + k, 300) * cand.length)];
      const ri = (i / W) | 0;
      const ci = i - ri * W;
      let u = ri - cr; // outward direction (rows, cols)
      let v = ci - cc;
      const len = Math.hypot(u, v);
      if (len < 1) continue;
      u /= len;
      v /= len;
      const I = loadHI[fuel[i]] * (ros[i] / 60);
      // retardant works on flanks and moderate fronts, not against the intense head
      let sc = I < AIR.I_LOW ? 1 : I < AIR.I_HIGH ? 0.7 : 0.15;
      // protect homes: unburned structures ahead of this edge
      for (let d = 3; d <= lookCells; d += 2) {
        const rr = Math.round(ri + u * d);
        const c2 = Math.round(ci + v * d);
        if (rr < 0 || rr >= H || c2 < 0 || c2 >= W) break;
        const j = rr * W + c2;
        if (FUELS[fuel[j]].structure && !(arrival[j] <= t)) {
          sc += 1.5 * (1 - d / (lookCells + 1));
          break;
        }
      }
      const pr = Math.round(ri + u * offCells);
      const pc = Math.round(ci + v * offCells);
      if (pr >= 0 && pr < H && pc >= 0 && pc < W && coated(pr * W + pc, t)) sc -= 1.2; // already covered
      sc += 0.3 * rand3(inp.seed, drops.length * 64 + k, 301);
      if (sc > bestS) ((bestS = sc), (best = i), (bu = u), (bv = v));
    }
    if (best < 0) return false;
    const ri = (best / W) | 0;
    const ci = best - ri * W;
    const half = (kind === DROP_RETARDANT ? AIR.LINE_M : AIR.WATER_LINE_M) / cellM / 2;
    const mr = ri + bu * offCells;
    const mc = ci + bv * offCells;
    // line runs across the outward direction (perpendicular), laid 4-connected so fire can't slip between cells
    const r0 = mr - bv * half;
    const c0 = mc + bu * half;
    const r1 = mr + bv * half;
    const c1 = mc - bu * half;
    const steps = Math.ceil(2 * half * 2) + 1;
    let pr = -1;
    let pc = -1;
    const coat = (rr: number, c2: number) => {
      if (rr < 0 || rr >= H || c2 < 0 || c2 >= W) return;
      const j = rr * W + c2;
      if (arrival[j] <= t || blocked[j] || fuel[j] === NONE) return;
      if (coated(j, t) && retKind[j] === DROP_RETARDANT && kind === DROP_WATER) return; // water doesn't replace retardant
      retT[j] = t;
      retKind[j] = kind;
    };
    for (let s2 = 0; s2 <= steps; s2++) {
      const f = s2 / steps;
      const rr = Math.round(r0 + (r1 - r0) * f);
      const c2 = Math.round(c0 + (c1 - c0) * f);
      if (pr >= 0 && rr !== pr && c2 !== pc) coat(pr, c2); // fill the diagonal step
      coat(rr, c2);
      if (kind === DROP_RETARDANT) coat(Math.round(rr + bu), Math.round(c2 + bv)); // tanker line ~2 cells (~100 m) deep
      pr = rr;
      pc = c2;
    }
    drops.push({ t, kind, r0, c0, r1, c1 });
    return true;
  };
  const airDrops = (t: number, gust: number) => {
    if (!airOn || !isFinite(tFirst) || t - tFirst < AIR.FIRST_MIN) return;
    const { flying } = aircraftFlying(t, tFirst, gust, clock0);
    if (flying <= 0) return;
    dropBudget += (flying * STATE_DT) / AIR.TURNAROUND_MIN;
    const day = isDaylight(t, clock0);
    let guard = 0;
    while (dropBudget >= 1 && guard++ < 30) {
      dropBudget -= 1;
      const kind = day && rand3(inp.seed, drops.length, 310) < AIR.TANKER_SHARE ? DROP_RETARDANT : DROP_WATER;
      if (!placeDrop(t, kind)) {
        dropBudget = 0;
        break;
      }
    }
    dropBudget = Math.min(dropBudget, 3);
  };

  // ---- New ignitions ----
  for (const ig of inp.ignitions) {
    const i = ig.cell;
    if (i < 0 || i >= n || blocked[i] || fuel[i] === NONE || done[i]) continue;
    const t = Math.max(ig.t, freezeT);
    if (t < arrival[i]) {
      arrival[i] = t;
      t0[i] = t;
      ros[i] = FUELS[fuel[i]].r0;
      spotted[i] = 0;
      heap.push(t, i);
    }
  }

  const cellHa = (cellM * cellM) / 10000;
  const DEG = 180 / Math.PI;
  const slopeMax = PHYS.SLOPE_MAX_DEG;
  const TAU = PHYS.TAU_ACCEL;
  const A = (1 - PHYS.GROWTH_FLOOR) * TAU;
  // Time to cover a hop that takes tFull at full speed, starting at fire age a:
  // solve  (b - a) - A (e^(-a/TAU) - e^(-b/TAU)) = tFull  for b (Newton).
  const hopTime = (a: number, tFull: number): number => {
    const ea = Math.exp(-a / TAU);
    let b = a + tFull;
    for (let it = 0; it < 4; it++) {
      const eb = Math.exp(-b / TAU);
      const F = b - a - A * (ea - eb) - tFull;
      const dF = 1 - (A / TAU) * eb; // = g(b)
      b -= F / dF;
    }
    return Math.max(tFull, b - a);
  };

  const whirls: WhirlEvent[] = [];
  const localHead = new Float64Array(FUELS.length);
  const URBAN_ID = URBAN;
  // Throw one ember from cell i; lands at lognormal distance, ignites with fuel receptivity.
  const throwEmber = (
    i: number, ri: number, ci: number, t: number, tE: number, tN: number,
    median: number, sigma: number, spreadDeg: number, dMin: number, dMax: number,
    dryF: number, salt: number, record = true,
  ): void => {
    const u1 = Math.max(1e-9, rand3(inp.seed, i, salt));
    const u2 = rand3(inp.seed, i, salt + 1);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const dist = median * Math.exp(sigma * z);
    const dAng = ((rand3(inp.seed, i, salt + 2) * 2 - 1) * spreadDeg * Math.PI) / 180;
    const ca = Math.cos(dAng);
    const sa = Math.sin(dAng);
    const de = tE * ca - tN * sa;
    const dn = tE * sa + tN * ca;
    const lr = Math.round(ri - (dn * dist) / cellM);
    const lc = Math.round(ci + (de * dist) / cellM);
    if (lr < 0 || lr >= H || lc < 0 || lc >= W) return;
    const j = lr * W + lc;
    if (j === i || done[j] || blocked[j] || fuel[j] === NONE) return;
    const recept = Math.min(1, FUELS[fuel[j]].recept * Math.min(1, dryF) * (FUELS[fuel[j]].structure ? structK(j) : structMult ? structMult[j] : 1));
    if (rand3(inp.seed, i, salt + 3) >= recept * (airOn && coated(j, t) ? AIR.EMBER_K : 1)) return;
    const delay = dMin + (dMax - dMin) * rand3(inp.seed, i, salt + 4);
    const tl = Math.fround(Math.max(t + delay, freezeT));
    if (tl < arrival[j] && tl <= horizon) {
      arrival[j] = tl;
      src[j] = i;
      ros[j] = FUELS[fuel[j]].r0;
      t0[j] = fuel[j] === URBAN_ID ? t0[i] : tl; // a house fire doesn't need to "accelerate"
      spotted[j] = record ? 1 : 0;
      heap.push(tl, j);
      if (record) spots.push({ from: i, to: j, tLaunch: t, tLand: tl });
    }
  };

  let pops = 0;
  const maxPops = 40 * n; // safety valve: never hang the worker
  while (heap.size > 0) {
    if (++pops > maxPops) {
      console.warn('[solver] pop limit hit', { heap: heap.size, freezeT, horizon });
      break;
    }
    const i = heap.pop();
    const t = heap.lastT;
    if (t > horizon) break;
    // stale entry (a faster path won, or a control line held here and reset the cell): skip
    if (done[i] || Math.fround(t) !== arrival[i]) continue;
    // Fire reaches a control line: it holds, or the fire overruns it / spots across it
    // only fire pushing out from inside the line (or embers thrown over it) tests the line;
    // fire that went around the end of the line just burns (the line was outflanked)
    // A cut line is bare ground: it can stop fire from either side. Only fire pushing out from inside
    // (or embers thrown over it) counts as an escape; fire coming around from outside that crosses it
    // is a burn-over, not an escape.
    const fromInside = src[i] < 0 || arrival[src[i]] <= protectT[i] || spotted[i] === 1;
    if (protectT[i] <= t && t > freezeT) {
      const e0 = envs[envIdx(t)];
      const I = loadHI[fuel[i]] * (ros[i] / 60);
      const p = breachProbability(I, e0.U, spotted[i] === 1, e0.U10 > RESPONSE.CRISIS_WIND_MS);
      // one draw per cell per intensity class: a line that held against this fire keeps holding
      if (rand3(inp.seed, i, 200 + Math.min(20, Math.floor(I / 4000)) + (spotted[i] ? 50 : 0)) >= p) {
        arrival[i] = Infinity; // line held here
        spotted[i] = 0;
        continue;
      }
      if (fromInside) breaches.push({ cell: i, t, kind: spotted[i] ? 'spot' : 'overrun' });
    }
    done[i] = 1;
    popOrder.push(i);
    if (FUELS[fuel[i]].structure && t > freezeT) structPops.push(t);

    const env = envs[envIdx(t)];
    const ri = (i / W) | 0;
    const ci = i - ri * W;
    // Fire age at this cell; acceleration g(s) = 1 - (1-floor) e^(-s/TAU)
    const age = t - t0[i];
    const accelDone = age > 5 * TAU;

    // ---- Fire-generated weather: update state on a fixed tick, then local wind for this cell ----
    if (nextTick === -Infinity) nextTick = Math.floor(t / STATE_DT) * STATE_DT;
    while (t >= nextTick) {
      const e = envs[envIdx(nextTick)];
      const last = wxTimeline.length ? wxTimeline[wxTimeline.length - 1] : null;
      wx = updateFireWx(tracker, last, nextTick, e.U10, e.fromDeg, cellM, inp.seed, Math.round(nextTick / STATE_DT), wxOn);
      wxTimeline.push(wx);
      if (nextTick > freezeT) {
        buildLine(nextTick, e.U10, weatherGust(nextTick));
        airDrops(nextTick, weatherGust(nextTick));
      }
      nextTick += STATE_DT;
    }
    // Cells re-opened from frozen history must use the fire weather of their own time
    if (t <= freezeT && wxTimeline.length) {
      let lo = 0;
      let hi = wxTimeline.length - 1;
      if (wxTimeline[0].t > t) wx = null;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (wxTimeline[mid].t <= t) lo = mid;
          else hi = mid - 1;
        }
        wx = wxTimeline[lo];
      }
    } else if (t > freezeT && wxTimeline.length && wx !== wxTimeline[wxTimeline.length - 1] && t >= wxTimeline[wxTimeline.length - 1].t) {
      wx = wxTimeline[wxTimeline.length - 1];
    }
    let ecc = env.ecc;
    let tE = env.towardE;
    let tN = env.towardN;
    let Uloc = env.U;
    let head = env.head;
    let dryLoc = env.dryF;
    let phi = 0;
    const exp = windExp ? windExp[i] : 1;
    if (exp < 0.999 && !(wx && wxOn)) {
      // terrain-sheltered cell, no fire weather: just scale the wind
      Uloc = env.U * exp;
      headRates(env.moisture, env.dryF, Uloc, env.U10 * exp, localHead);
      head = localHead;
      ecc = eccentricity(Uloc);
    }
    if (wx && wxOn) {
      phi = wx.phi;
      const [we, wn] = fireWindAt(wx, t, env.U, tE, tN, exp, ri, ci, cellM);
      const mod = true;
      if (mod || phi > 0) {
        const Ul = Math.hypot(we, wn);
        if (Ul > 1e-3) {
          tE = we / Ul;
          tN = wn / Ul;
        }
        // When the plume dominates, ambient wind steers the fire less (slower head, rounder shape).
        const Uhead = Ul * (1 - FIREWX.PLUME_HEAD_DAMP * phi);
        const k = Uhead / Math.max(0.1, env.U);
        Uloc = Ul;
        headRates(env.moisture, env.dryF, Uhead, env.U10 * k, localHead);
        head = localHead;
        ecc = eccentricity(Ul * (1 - FIREWX.PLUME_SHAPE_DAMP * phi));
      }
    }
    dryLoc = env.dryF;
    // record this ignition for the fire-state window (skip frozen history)
    if (t > freezeT) {
      const R = ros[i] / 60;
      tracker.push(t, ri, ci, loadHI[fuel[i]] * R, R);
    }
    const ei = elev[i];
    const t0i = t0[i];

    for (let k = 0; k < K; k++) {
      const rr = ri + sDr[k];
      const cc = ci + sDc[k];
      if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
      const j = i + sDr[k] * W + sDc[k];
      if (done[j] || blocked[j]) continue;
      const fj = fuel[j];
      if (fj === NONE) continue;
      const cosT = sUe[k] * tE + sUn[k] * tN;
      let slopeDeg = Math.atan((elev[j] - ei) / sDist[k]) * DEG;
      if (slopeDeg > slopeMax) slopeDeg = slopeMax;
      else if (slopeDeg < -slopeMax) slopeDeg = -slopeMax;
      const slopeF = Math.exp(PHYS.SLOPE_K * slopeDeg);
      const rHead = head[fj] * hetero[j] * (FUELS[fj].structure ? structK(j) : slopeF * (structMult ? structMult[j] : 1));
      let r = Math.max(PHYS.ROS_MIN, directionalRate(rHead, ecc, cosT));
      // Firefighting: low-intensity vegetation edges get held back once crews arrive
      if (suppressOn && t - t0i > PHYS.SUPPRESS_START_MIN) {
        const iMax = env.U10 < PHYS.SUPPRESS_AIR_WIND_MS ? PHYS.SUPPRESS_I_MAX_AIR : PHYS.SUPPRESS_I_MAX;
        const Ij = loadHI[fj] * (r / 60);
        if (!FUELS[fj].structure && Ij < iMax) r *= env.U10 < PHYS.SUPPRESS_AIR_WIND_MS && Ij < PHYS.EXTINGUISH_I_MAX ? PHYS.EXTINGUISH_K : PHYS.SUPPRESS_K;
        else if (FUELS[fj].structure && structMult && structMult[j] < PHYS.STRUCT_DEFEND_BELOW) r *= PHYS.STRUCT_DEFEND_K;
      }
      const mode = sMode[k];
      // Air drops: coated fuel (or a coated cell the move passes) slows the fire, less so when it is intense
      if (airOn && (coated(j, t) || (mode !== 0 && (coated(i + sMidA[k], t) || coated(i + sMidB[k], t))))) {
        const Ij = loadHI[fj] * (r / 60);
        const x = Math.min(1, Math.max(0, (Ij - AIR.I_LOW) / (AIR.I_HIGH - AIR.I_LOW)));
        r *= AIR.K_LOW + (AIR.K_HIGH - AIR.K_LOW) * x;
      }
      // Barriers: blocked always stops; road stops only slow fire. Check cells the move passes.
      const slow = r < breach;
      if (slow && road[j]) continue;
      if (mode !== 0) {
        const a = i + sMidA[k];
        const b = i + sMidB[k];
        // control lines also block moves that would hop over them
        const ba = blocked[a] || (slow && road[a]) || protectT[a] <= t;
        const bb = blocked[b] || (slow && road[b]) || protectT[b] <= t;
        if (mode === 1 ? ba && bb : ba || bb) continue;
      }
      const tFull = sDist[k] / r; // travel time at full (accelerated) rate
      const hop = accelDone ? tFull : hopTime(age, tFull);
      let tj = t + hop;
      if (tj < freezeT) tj = freezeT;
      tj = Math.fround(tj);
      if (tj < arrival[j]) {
        arrival[j] = tj;
        src[j] = i;
        ros[j] = accelDone ? r : (r * tFull) / hop;
        t0[j] = t0i;
        spotted[j] = 0;
        heap.push(tj, j);
      }
    }

    // ---- Spotting: once per cell, from ember-producing fuels in strong wind ----
    const fsrc = FUELS[fuel[i]].spot;
    if (fsrc > 0 && (Uloc > PHYS.SPOT_U_MIN || phi > 0.05)) {
      const pWind = Uloc > PHYS.SPOT_U_MIN ? PHYS.SPOT_PER_HA_PER_MS * cellHa * (Uloc - PHYS.SPOT_U_MIN) : 0;
      const p = (pWind + FIREWX.PLUME_SPOT_P * phi) * fsrc * Math.min(1.5, dryLoc);
      if (rand3(inp.seed, i, 1) < p) {
        // a standing plume lofts embers higher: farther, and in more directions
        const median = PHYS.SPOT_MEDIAN_PER_MS * Math.max(Uloc, 6) * (1 + FIREWX.PLUME_SPOT_DIST_K * phi);
        const spread = PHYS.SPOT_SPREAD_DEG + FIREWX.PLUME_SPOT_SPREAD_DEG * phi;
        throwEmber(i, ri, ci, t, tE, tN, median, PHYS.SPOT_SIGMA, spread, PHYS.SPOT_DELAY_MIN, PHYS.SPOT_DELAY_MAX, dryLoc, 10);
      }
    }
    // ---- Fire whirls: rare, on intense flanks in strong wind; scatter embers in all directions ----
    if (wxOn && wx && env.U > FIREWX.WHIRL_U_MIN && loadHI[fuel[i]] * (ros[i] / 60) > FIREWX.WHIRL_I_MIN) {
      const dx = (ci - wx.heatC) * cellM;
      const dy = -(ri - wx.heatR) * cellM;
      const d = Math.hypot(dx, dy) || 1;
      if (Math.abs((dx * tE + dy * tN) / d) < FIREWX.WHIRL_FLANK_COS && rand3(inp.seed, i, 90) < FIREWX.WHIRL_P) {
        whirls.push({ cell: i, t });
        for (let w = 0; w < FIREWX.WHIRL_EMBERS; w++) {
          throwEmber(i, ri, ci, t, tE, tN, FIREWX.WHIRL_MEDIAN_M, 0.5, 180, 1, 3, dryLoc, 100 + w * 10);
        }
      }
    }
    // ---- House-to-house: burning structures ignite neighbours (radiant heat + short embers) ----
    if (fuel[i] === URBAN) {
      for (let h = 0; h < 2; h++) {
        if (rand3(inp.seed, i, 30 + h) < PHYS.HOUSE_SPOT_P) {
          throwEmber(i, ri, ci, t, tE, tN, PHYS.HOUSE_SPOT_MEDIAN_M * (1 + Uloc / 15), PHYS.HOUSE_SPOT_SIGMA, PHYS.HOUSE_SPOT_SPREAD_DEG, PHYS.HOUSE_SPOT_DELAY_MIN, PHYS.HOUSE_SPOT_DELAY_MAX, env.dryF, 40 + h * 10, false);
        }
      }
    }
  }

  // Anything beyond horizon stays unknown
  for (let i = 0; i < n; i++) if (arrival[i] > horizon) arrival[i] = Infinity;

  // Keep only embers whose landing actually started the fire there
  const realSpots = spots.filter((s) => spotted[s.to] === 1 && arrival[s.to] === s.tLand);

  return { arrival, ros, t0, spotted, spots: realSpots, whirls, lineT, protectT, breaches, retT, retKind, drops, fireWx: wxTimeline, horizon, ms: performance.now() - start };
}
