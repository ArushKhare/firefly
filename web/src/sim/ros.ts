// Rate-of-spread model: weather (wind, gusts, temp, RH, rain) -> spread rates.
// Pure functions. No DOM.
import { FUELS, PHYS } from '../config.ts';
import { rand3 } from './terrain.ts';

/** One weather sample. atMinute is sim minutes from sim start (t = 0). */
export interface WeatherPoint {
  atMinute: number;
  speedMps: number; // 10 m mean wind
  gustMps: number;
  fromDeg: number; // meteorological: direction wind comes FROM
  tempC: number;
  rh: number; // %
  rain24: number; // mm in previous 24 h
}

/** Fire environment at one instant, precomputed for the solver. */
export interface Env {
  U: number; // effective wind m/s (mean + part of gust)
  U10: number; // mean 10 m wind m/s (for empirical rules)
  fromDeg: number;
  towardE: number; // unit vector the wind blows toward (east, north)
  towardN: number;
  ecc: number; // ellipse eccentricity
  lw: number; // length-to-width ratio
  moisture: number; // fine dead fuel moisture %
  dryF: number; // moisture multiplier on spread
  head: Float64Array; // head-fire rate m/min per fuel id, before slope/hetero/growth
}

/** Simard (1968) equilibrium moisture content, %. Standard fire-weather formula. */
export function emc(tempC: number, rh: number): number {
  const T = tempC * 1.8 + 32;
  const H = Math.min(100, Math.max(0, rh));
  if (H < 10) return 0.03229 + 0.281073 * H - 0.000578 * H * T;
  if (H < 50) return 2.22749 + 0.160107 * H - 0.01478 * T;
  return 21.0606 + 0.005565 * H * H - 0.00035 * H * T - 0.483199 * H;
}

export function fuelMoisture(p: WeatherPoint): number {
  const rainBump = Math.min(PHYS.RAIN_MOIST_MAX, p.rain24 * PHYS.RAIN_MOIST_PER_MM);
  return Math.max(1.5, emc(p.tempC, p.rh) + rainBump);
}

export function dryFactor(moisture: number, drynessMult: number): number {
  const f = Math.exp(-PHYS.MOIST_K * (moisture - PHYS.MOIST_REF));
  return Math.min(PHYS.DRY_MAX, Math.max(PHYS.DRY_MIN, f)) * drynessMult;
}

export function effectiveWind(speed: number, gust: number): number {
  return speed + PHYS.GUST_WEIGHT * Math.max(0, gust - speed);
}

/** Alexander (1985) length-to-width ratio, U in m/s. */
export function lengthToWidth(U: number): number {
  const kmh = U * 3.6;
  const lw = 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * kmh), 2.155);
  return Math.min(PHYS.LW_MAX, lw);
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function crownFactor(U: number, moisture: number): number {
  const windGate = smoothstep(PHYS.CROWN_U0, PHYS.CROWN_U1, U);
  const dryGate = 1 - smoothstep(PHYS.CROWN_MOIST_FULL, PHYS.CROWN_MOIST_NONE, moisture);
  return 1 + (PHYS.CROWN_MULT - 1) * windGate * dryGate;
}

/** Weather at sim minute t: speeds/temps linear, direction along the shortest arc. */
export function weatherAt(ws: WeatherPoint[], t: number): WeatherPoint {
  if (ws.length === 0) throw new Error('empty weather schedule');
  if (t <= ws[0].atMinute) return ws[0];
  const last = ws[ws.length - 1];
  if (t >= last.atMinute) return last;
  let k = 0;
  while (k + 1 < ws.length && ws[k + 1].atMinute <= t) k++;
  const a = ws[k];
  const b = ws[k + 1];
  const f = (t - a.atMinute) / (b.atMinute - a.atMinute);
  const lerp = (x: number, y: number) => x + (y - x) * f;
  const dd = ((b.fromDeg - a.fromDeg + 540) % 360) - 180;
  return {
    atMinute: t,
    speedMps: lerp(a.speedMps, b.speedMps),
    gustMps: lerp(a.gustMps, b.gustMps),
    fromDeg: (a.fromDeg + dd * f + 360) % 360,
    tempC: lerp(a.tempC, b.tempC),
    rh: lerp(a.rh, b.rh),
    rain24: lerp(a.rain24, b.rain24),
  };
}

export function envFromWeather(p: WeatherPoint, drynessMult: number): Env {
  const U = effectiveWind(p.speedMps, p.gustMps);
  const toward = ((p.fromDeg + 180) * Math.PI) / 180;
  const moisture = fuelMoisture(p);
  const dryF = dryFactor(moisture, drynessMult);
  const lw = lengthToWidth(U);
  const ecc = Math.sqrt(1 - 1 / (lw * lw));
  const head = new Float64Array(FUELS.length);
  headRates(moisture, dryF, U, p.speedMps, head);
  return { U, U10: p.speedMps, fromDeg: p.fromDeg, towardE: Math.sin(toward), towardN: Math.cos(toward), ecc, lw, moisture, dryF, head };
}

/**
 * Head-fire rate (m/min) per fuel for effective wind Ueff and mean wind U10.
 * Blend of the wind-power model (light wind) and the empirical 10%/20% rules (strong wind).
 */
export function headRates(moisture: number, dryF: number, Ueff: number, U10: number, out: Float64Array): void {
  const crown = crownFactor(Ueff, moisture);
  const uPow = Math.pow(Ueff, PHYS.B_WIND);
  const wEmp = smoothstep(PHYS.EMP_U0, PHYS.EMP_U1, U10);
  const dryRel = Math.min(PHYS.EMP_DRY_MAX, dryF / PHYS.EMP_DRY_REF);
  for (let f = 0; f < FUELS.length; f++) {
    const fp = FUELS[f];
    if (fp.structure) {
      const urbanRate = (PHYS.STRUCT_R0 + PHYS.STRUCT_UK * Ueff) * Math.min(PHYS.STRUCT_DRY_MAX, dryF);
      out[f] = fp.name === 'city' ? urbanRate * PHYS.STRUCT_CITY_K : urbanRate;
      continue;
    }
    const model = fp.r0 * (1 + fp.windA * uPow) * dryF * (fp.crown ? crown : 1);
    const emp = fp.emp * U10 * 60 * dryRel;
    out[f] = (1 - wEmp) * model + wEmp * Math.max(emp, fp.r0 * dryF);
  }
}

export function eccentricity(U: number): number {
  const lw = lengthToWidth(U);
  return Math.sqrt(1 - 1 / (lw * lw));
}

/**
 * Seeded gust noise: Ornstein-Uhlenbeck series per sim minute for wind speed
 * (multiplier) and direction (degrees offset). Same seed -> same gusts.
 */
export function gustSeries(seed: number, minutes: number, sigmaSpeed: number, sigmaDirDeg: number, tauMin: number) {
  const n = Math.max(1, Math.ceil(minutes) + 2);
  const speed = new Float32Array(n);
  const dir = new Float32Array(n);
  const a = Math.exp(-1 / tauMin);
  const b = Math.sqrt(1 - a * a);
  let x1 = gauss(seed, 0, 500);
  let x2 = gauss(seed, 0, 600);
  for (let k = 0; k < n; k++) {
    speed[k] = Math.exp(sigmaSpeed * x1 - (sigmaSpeed * sigmaSpeed) / 2);
    dir[k] = sigmaDirDeg * x2;
    x1 = a * x1 + b * gauss(seed, k + 1, 500);
    x2 = a * x2 + b * gauss(seed, k + 1, 600);
  }
  return { speed, dir };
}

function gauss(seed: number, k: number, salt: number): number {
  const u1 = Math.max(1e-9, rand3(seed, k, salt));
  const u2 = rand3(seed, k, salt + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function envAt(ws: WeatherPoint[], t: number, drynessMult: number): Env {
  return envFromWeather(weatherAt(ws, t), drynessMult);
}

/** One Env per sim minute from t0 to t1 inclusive (solver lookup table), with optional gust noise. */
export function buildEnvTable(
  ws: WeatherPoint[],
  t0: number,
  t1: number,
  drynessMult: number,
  gusts?: { speed: Float32Array; dir: Float32Array },
): Env[] {
  const out: Env[] = [];
  for (let t = t0; t <= t1; t++) {
    const p = weatherAt(ws, t);
    if (gusts) {
      const k = Math.min(gusts.speed.length - 1, Math.max(0, t));
      const m = gusts.speed[k];
      out.push(envFromWeather({ ...p, speedMps: p.speedMps * m, gustMps: p.gustMps * m, fromDeg: (p.fromDeg + gusts.dir[k] + 360) % 360 }, drynessMult));
    } else out.push(envFromWeather(p, drynessMult));
  }
  return out;
}

/** Spread rate (m/min) of an ellipse whose head rate is rHead, at angle with cos = cosTheta. */
export function directionalRate(rHead: number, ecc: number, cosTheta: number): number {
  return (rHead * (1 - ecc)) / (1 - ecc * cosTheta);
}
