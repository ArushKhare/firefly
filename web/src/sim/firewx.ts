// Fire-generated weather: a cheap parameterization driven by the fire's own state.
// The solver pops cells in time order, so at any time t it knows what is burning
// and can feed that back into the wind (causal, deterministic for a given seed).
// Pure. No DOM.
import { FIREWX } from '../config.ts';
import { rand3 } from './terrain.ts';

export interface FireWxSample {
  t: number;
  U10: number; // ambient mean wind incl. gust noise, m/s
  fromDeg: number;
  intensity: number; // intensity-weighted mean Byram intensity, kW/m
  nc: number; // Byram convective number
  phi: number; // 0 wind-driven .. 1 plume-dominated
  indraft: number; // m/s
  collapseUntil: number; // sim minute; > t means a column collapse is active
  collapseR: number; // collapse centre (fractional row/col) and outflow speed
  collapseC: number;
  collapseU: number;
  heatR: number; // heat centre
  heatC: number;
  areaCells: number; // burned cells so far (fire size scale for indraft reach)
}

/**
 * Fire-modified wind at cell (r, c): ambient (x terrain exposure) + indraft + collapse outflow.
 * Indraft: in wind, only the cross-wind part (flanks pulled in); in calm, a radial pull toward the fire.
 * Shared by the solver and the wind streaks, so what you see is what the fire feels. Returns m/s (east, north).
 */
export function fireWindAt(
  wx: FireWxSample,
  t: number,
  U: number,
  tE: number,
  tN: number,
  exposure: number,
  r: number,
  c: number,
  cellM: number,
): [number, number] {
  let we = U * exposure * tE;
  let wn = U * exposure * tN;
  if (wx.indraft > 0.05 && wx.areaCells > 0) {
    const dx = (c - wx.heatC) * cellM;
    const dy = -(r - wx.heatR) * cellM;
    const d = Math.hypot(dx, dy);
    if (d > cellM) {
      const L = Math.max(300, Math.sqrt(wx.areaCells) * cellM);
      const mag = wx.indraft * Math.exp(-Math.max(0, d - L) / L);
      const ve = (-dx / d) * mag;
      const vn = (-dy / d) * mag;
      const along = ve * tE + vn * tN;
      const windy = Math.min(1, Math.max(0, (U - 2) / 4)); // 0 calm .. 1 windy
      we += ve - along * tE * windy;
      wn += vn - along * tN * windy;
    }
  }
  if (wx.collapseUntil > t) {
    const dx = (c - wx.collapseC) * cellM;
    const dy = -(r - wx.collapseR) * cellM;
    const d = Math.hypot(dx, dy);
    if (d > cellM) {
      const mag = wx.collapseU * Math.exp(-d / FIREWX.COLLAPSE_RADIUS_M);
      we += (dx / d) * mag;
      wn += (dy / d) * mag;
    }
  }
  return [we, wn];
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Rolling window of recent ignitions with running sums. */
export class FireTracker {
  private qt: number[] = [];
  private qI: number[] = [];
  private qR: number[] = [];
  private qr: number[] = [];
  private qc: number[] = [];
  private head = 0;
  private sumI = 0;
  private sumI2 = 0;
  private sumIR = 0;
  private sumIr = 0;
  private sumIc = 0;
  count = 0;
  totalCells = 0;

  /** I: Byram intensity kW/m, R: spread rate m/s. */
  push(t: number, r: number, c: number, I: number, R: number): void {
    this.qt.push(t);
    this.qI.push(I);
    this.qR.push(R);
    this.qr.push(r);
    this.qc.push(c);
    this.sumI += I;
    this.sumI2 += I * I;
    this.sumIR += I * R;
    this.sumIr += I * r;
    this.sumIc += I * c;
    this.count++;
    this.totalCells++;
  }

  evict(tMin: number): void {
    while (this.head < this.qt.length && this.qt[this.head] < tMin) {
      const k = this.head++;
      const I = this.qI[k];
      this.sumI -= I;
      this.sumI2 -= I * I;
      this.sumIR -= I * this.qR[k];
      this.sumIr -= I * this.qr[k];
      this.sumIc -= I * this.qc[k];
      this.count--;
    }
    if (this.head > 4096 && this.head > this.qt.length / 2) {
      for (const a of [this.qt, this.qI, this.qR, this.qr, this.qc]) a.splice(0, this.head);
      this.head = 0;
    }
  }

  /** Intensity-weighted means (head fire dominates). */
  stats(): { I: number; R: number; r: number; c: number } {
    if (this.sumI <= 1e-6) return { I: 0, R: 0, r: 0, c: 0 };
    return { I: this.sumI2 / this.sumI, R: this.sumIR / this.sumI, r: this.sumIr / this.sumI, c: this.sumIc / this.sumI };
  }
}

/** Byram (1959) convective number: plume power vs wind power for a line fire. */
export function convectiveNumber(IkWm: number, U: number, R: number): number {
  const g = 9.81;
  const rho = 1.2;
  const cp = 1005;
  const T = 300;
  const rel = Math.max(0.5, U - R);
  return Math.min(50, (2 * g * IkWm * 1000) / (rho * cp * T * rel * rel * rel));
}

/** Advance fire weather to time t; returns the new sample. */
export function updateFireWx(
  tr: FireTracker,
  prev: FireWxSample | null,
  t: number,
  U10: number,
  fromDeg: number,
  cellM: number,
  seed: number,
  tick: number,
  enabled: boolean,
): FireWxSample {
  tr.evict(t - FIREWX.WINDOW_MIN);
  const s = tr.stats();
  const nc = convectiveNumber(s.I, U10, s.R);
  const areaHa = (tr.totalCells * cellM * cellM) / 10000;
  const phi = enabled ? smooth(FIREWX.NC_LO, FIREWX.NC_HI, nc) * smooth(FIREWX.PLUME_MIN_HA, FIREWX.PLUME_FULL_HA, areaHa) : 0;

  // Indraft scales with fire power ~ intensity x active front length
  const depth = Math.max(cellM, s.R * 60 * FIREWX.WINDOW_MIN);
  const frontLen = (tr.count * cellM * cellM) / depth;
  const powerGW = (s.I * frontLen) / 1e6;
  const indraft = enabled ? FIREWX.INDRAFT_MAX * (1 - Math.exp(-powerGW / FIREWX.INDRAFT_P0_GW)) : 0;

  let collapseUntil = prev?.collapseUntil ?? -Infinity;
  let collapseR = prev?.collapseR ?? 0;
  let collapseC = prev?.collapseC ?? 0;
  let collapseU = prev?.collapseU ?? 0;
  if (enabled && collapseUntil <= t && phi > FIREWX.COLLAPSE_PHI && s.I > FIREWX.COLLAPSE_I_MIN && rand3(seed, tick, 77) < FIREWX.COLLAPSE_P_PER_TICK * phi) {
    collapseUntil = t + FIREWX.COLLAPSE_MIN + (FIREWX.COLLAPSE_MAX - FIREWX.COLLAPSE_MIN) * rand3(seed, tick, 78);
    collapseR = s.r;
    collapseC = s.c;
    collapseU = FIREWX.COLLAPSE_SPEED_MIN + (FIREWX.COLLAPSE_SPEED_MAX - FIREWX.COLLAPSE_SPEED_MIN) * rand3(seed, tick, 79);
  }
  return { t, U10, fromDeg, intensity: s.I, nc, phi, indraft, collapseUntil, collapseR, collapseC, collapseU, heatR: s.r, heatC: s.c, areaCells: tr.totalCells };
}
