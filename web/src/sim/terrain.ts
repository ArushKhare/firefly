// Synthetic terrain, fuel map and heterogeneity. Pure and seeded. No DOM.
import { W, H, CELL_M, NONE, GRASS, SHRUB, FOREST } from '../config.ts';
import { type StaticGrid, stampLine } from './grid.ts';

// ---------- Seeded hashing / noise ----------
export function hash32(a: number): number {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic random in [0,1) for (seed, i, salt). Stable across recomputes. */
export function rand3(seed: number, i: number, salt: number): number {
  return hash32(Math.imul(seed, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77) ^ Math.imul(salt + 7, 0xc2b2ae3d));
}

function lattice(x: number, y: number, seed: number): number {
  return rand3(seed, Math.imul(x, 73856093) ^ Math.imul(y, 19349663), 11);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = lattice(xi, yi, seed);
  const b = lattice(xi + 1, yi, seed);
  const c = lattice(xi, yi + 1, seed);
  const d = lattice(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise stretched to roughly [0,1]. */
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, y * f, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  const n = sum / norm; // ~0.5 mean, compressed range
  return Math.min(1, Math.max(0, (n - 0.5) * 2.2 + 0.5));
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// River runs N-S in the eastern canyon (normalized coords).
const riverX = (ny: number) => 0.87 + 0.035 * Math.sin(ny * 9 + 0.7) + 0.015 * Math.sin(ny * 23);

// Roads as normalized polylines [x, y] (x east, y south). Synthetic, not real roads.
const ROADS: [number, number][][] = [
  // diagonal main road SW -> NE (Skyway-like)
  [[0.12, 0.98], [0.3, 0.72], [0.42, 0.55], [0.55, 0.38], [0.66, 0.2], [0.72, 0.02]],
  // N-S road on the east side
  [[0.62, 0.95], [0.63, 0.7], [0.61, 0.5], [0.64, 0.3]],
  // E-W connector
  [[0.2, 0.62], [0.4, 0.6], [0.6, 0.63], [0.78, 0.6]],
];

export function generateTerrain(seed: number): StaticGrid {
  const n = W * H;
  const fuel = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const road = new Uint8Array(n);
  const elev = new Float32Array(n);
  const hetero = new Float32Array(n);

  // ---- Elevation: central ridge, canyons W and E, rising to the north ----
  let eMin = Infinity;
  let eMax = -Infinity;
  for (let r = 0; r < H; r++) {
    const ny = r / H;
    const ridgeX = 0.5 + 0.06 * Math.sin(ny * 5 + 1);
    for (let c = 0; c < W; c++) {
      const nx = c / W;
      const ridge = Math.exp(-(((nx - ridgeX) / 0.22) ** 2));
      const westCanyon = Math.exp(-(((nx - 0.06) / 0.07) ** 2));
      const eastCanyon = Math.exp(-(((nx - riverX(ny)) / 0.06) ** 2));
      const f = fbm(nx * 5, ny * 5, seed, 5);
      const e = 120 + 200 * ridge + 110 * (1 - ny) + 120 * (f - 0.5) - 150 * westCanyon - 170 * eastCanyon;
      elev[r * W + c] = e;
      if (e < eMin) eMin = e;
      if (e > eMax) eMax = e;
    }
  }

  // ---- Fuel from noise, biased by elevation (forest higher, grass in valleys) ----
  for (let r = 0; r < H; r++) {
    const ny = r / H;
    for (let c = 0; c < W; c++) {
      const nx = c / W;
      const i = r * W + c;
      const en = (elev[i] - eMin) / (eMax - eMin);
      const fn = fbm(nx * 9 + 50, ny * 9 + 50, seed + 1, 4);
      const v = fn * 0.7 + en * 0.45 - 0.1;
      fuel[i] = v < 0.33 ? GRASS : v < 0.5 ? SHRUB : FOREST;
      // fine-scale heterogeneity 0.6..1.4
      const h = 0.65 * fbm(nx * 34 + 9, ny * 34 + 3, seed + 2, 4) + 0.35 * fbm(nx * 120, ny * 120, seed + 3, 2);
      hetero[i] = 0.6 + 0.8 * Math.min(1, Math.max(0, (h - 0.5) * 1.6 + 0.5));
    }
  }

  // ---- Clearings ----
  for (let k = 0; k < 9; k++) {
    const cr = rand3(seed, k, 21) * H;
    const cc = rand3(seed, k, 22) * W;
    const rad = 4 + rand3(seed, k, 23) * 9;
    for (let r = Math.floor(cr - rad); r <= cr + rad; r++) {
      for (let c = Math.floor(cc - rad); c <= cc + rad; c++) {
        if (r < 0 || r >= H || c < 0 || c >= W) continue;
        const wob = 1 + 0.35 * (fbm(c / 6, r / 6, seed + 30 + k, 2) - 0.5);
        if ((r - cr) ** 2 + (c - cc) ** 2 <= (rad * wob) ** 2) fuel[r * W + c] = GRASS;
      }
    }
  }

  // ---- River (water: fuel NONE + blocked) ----
  for (let r = 0; r < H; r++) {
    const ny = r / H;
    const cx = riverX(ny) * W;
    const half = 2 + 1.2 * Math.sin(ny * 13);
    for (let c = Math.floor(cx - half - 1); c <= cx + half + 1; c++) {
      if (c < 0 || c >= W) continue;
      if (Math.abs(c - cx) <= half) {
        fuel[r * W + c] = NONE;
        blocked[r * W + c] = 1;
      }
    }
  }

  // ---- Roads (partial barrier; underlying fuel kept) ----
  for (const line of ROADS) {
    for (let k = 0; k + 1 < line.length; k++) {
      const [x0, y0] = line[k];
      const [x1, y1] = line[k + 1];
      stampLine(road, W, H, y0 * H, x0 * W, y1 * H, x1 * W, 0.6);
    }
  }

  for (let i = 0; i < n; i++) if (blocked[i]) road[i] = 0;
  return { W, H, cellM: CELL_M, fuel, blocked, road, elev, hetero };
}
