// Fuel classification from real per-cell features (satellite colour/texture + terrain).
// Thresholds calibrated on Esri imagery at known LA points (ocean, Palisades/Altadena homes,
// Pasadena/Hollywood dense city, Santa Monica / San Gabriel chaparral). Pure. No DOM.
import { CELL_M, CITY, FOREST, GRASS, H, NONE, PHYS, SHRUB, URBAN, W } from '../config.ts';
import { cellToLatLng, type StaticGrid } from './grid.ts';
import { fbm } from './terrain.ts';

export interface CellFeatures {
  elev: Float32Array;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  lumStd: Float32Array; // within-cell brightness std (texture: roofs/streets are high)
  blueFrac: Float32Array;
}

/** Vision land-cover labels (OpenRouter vision model, one 4x4 grid per z14 imagery tile). */
export interface VisionLandcover {
  zoom: number;
  blocks: number;
  tiles: { x: number; y: number; grid: string[] }[];
}

/** Per-cell vision letter (char code), 0 where no label. Pure mercator maths, no DOM. */
export function visionPerCell(v: VisionLandcover): Uint8Array {
  const out = new Uint8Array(W * H);
  const map = new Map<string, string[]>();
  for (const t of v.tiles) map.set(`${t.x},${t.y}`, t.grid);
  const n = 2 ** v.zoom;
  for (let row = 0; row < H; row++) {
    for (let c = 0; c < W; c++) {
      const ll = cellToLatLng(row, c);
      const s = Math.sin((ll.lat * Math.PI) / 180);
      const fx = ((ll.lng + 180) / 360) * n;
      const fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
      const g = map.get(`${Math.floor(fx)},${Math.floor(fy)}`);
      if (!g) continue;
      const bx = Math.min(v.blocks - 1, Math.floor((fx % 1) * v.blocks));
      const by = Math.min(v.blocks - 1, Math.floor((fy % 1) * v.blocks));
      out[row * W + c] = g[by]?.charCodeAt(bx) ?? 0;
    }
  }
  return out;
}

const VEG = (k: number) => k === GRASS || k === SHRUB || k === FOREST;
const BUILT = (k: number) => k === URBAN || k === CITY;

/** Merge a pixel class with the 500 m vision label. Returns [fuel, irrigated]. */
function mergeVision(k: number, letter: string): [number, boolean] {
  switch (letter) {
    case 'W':
    case 'B':
      return k === NONE ? [NONE, false] : letter === 'B' ? [NONE, false] : [k, false];
    case 'G':
      return [BUILT(k) ? URBAN : k === NONE ? NONE : GRASS, false];
    case 'C':
      return [BUILT(k) ? URBAN : k === FOREST ? FOREST : k === NONE ? NONE : SHRUB, false];
    case 'F':
      return [BUILT(k) ? URBAN : k === NONE ? NONE : FOREST, false];
    case 'U':
      return [BUILT(k) ? URBAN : k, false];
    case 'S':
      return BUILT(k) ? [URBAN, false] : VEG(k) ? [k, true] : [k, false];
    case 'D':
      return BUILT(k) ? [CITY, false] : VEG(k) ? [k, true] : [k, false];
    case 'I':
      return k === NONE ? [NONE, false] : [GRASS, true];
    default:
      return [k, false];
  }
}

/** Distance (cells, 4-neighbour BFS) to the nearest wildland vision block (C, F, G). */
function distanceToWildland(vision: Uint8Array): Uint16Array {
  const n = W * H;
  const d = new Uint16Array(n).fill(65535);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const C = 'C'.charCodeAt(0);
  const F = 'F'.charCodeAt(0);
  const G = 'G'.charCodeAt(0);
  for (let i = 0; i < n; i++) {
    if (vision[i] === C || vision[i] === F || vision[i] === G) {
      d[i] = 0;
      q[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = q[qh++];
    const r = (i / W) | 0;
    const c = i - r * W;
    const nd = d[i] + 1;
    if (c > 0 && d[i - 1] > nd) ((d[i - 1] = nd), (q[qt++] = i - 1));
    if (c < W - 1 && d[i + 1] > nd) ((d[i + 1] = nd), (q[qt++] = i + 1));
    if (r > 0 && d[i - W] > nd) ((d[i - W] = nd), (q[qt++] = i - W));
    if (r < H - 1 && d[i + W] > nd) ((d[i + W] = nd), (q[qt++] = i + W));
  }
  return d;
}

export function classify(f: CellFeatures, seed: number, vision?: Uint8Array): StaticGrid {
  const n = W * H;
  const fuel = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const road = new Uint8Array(n);
  const hetero = new Float32Array(n);
  const irrigated = new Uint8Array(n); // vegetation that is irrigated urban greenery (vision S/D/I blocks)
  const wildDist = vision ? distanceToWildland(vision) : null;
  const interfaceCells = PHYS.INTERFACE_M / CELL_M;
  const { r, g, b, lumStd, blueFrac } = f;
  // Terrarium has no-data values offshore (thousands of metres below sea level): clamp to sea level
  const elev = new Float32Array(f.elev);
  for (let i = 0; i < n; i++) if (elev[i] < -50) elev[i] = 0;

  for (let row = 0; row < H; row++) {
    for (let c = 0; c < W; c++) {
      const i = row * W + c;
      // slope (deg) from neighbours
      const e = elev[i];
      const ex = (elev[row * W + Math.min(W - 1, c + 1)] - elev[row * W + Math.max(0, c - 1)]) / (2 * CELL_M);
      const ey = (elev[Math.min(H - 1, row + 1) * W + c] - elev[Math.max(0, row - 1) * W + c]) / (2 * CELL_M);
      const slope = (Math.atan(Math.hypot(ex, ey)) * 180) / Math.PI;

      const R = r[i];
      const G = g[i];
      const B = b[i];
      const mx = Math.max(R, G, B);
      const mn = Math.min(R, G, B);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      const lum = 0.299 * R + 0.587 * G + 0.114 * B;
      const std = lumStd[i];

      let k: number;
      if (blueFrac[i] > 0.5 || (e < 1 && B >= R)) {
        k = NONE; // ocean, reservoirs
      } else if (sat < 0.17 && std > 28 && slope < 15) {
        k = CITY; // grey, busy texture, flat: dense city
      } else if ((sat < 0.18 && std >= 22) || (sat < 0.24 && std > 26 && slope < 12)) {
        k = URBAN; // homes among trees: wildland-urban interface
      } else if (R >= G - 2 && lum > 100 && std < 22) {
        k = GRASS; // tan/brown, smooth: dry grass
      } else if (lum < 75 && G > R) {
        k = FOREST; // dark dense canopy (heavy chaparral, oak/riparian, conifers)
      } else {
        k = SHRUB; // chaparral / coastal sage scrub
      }
      if (vision && vision[i]) {
        const letter = String.fromCharCode(vision[i]);
        const [k2, irr] = mergeVision(k, letter);
        k = k2;
        // suburban yards next to wildland are interface WUI, not irrigated greenery (e.g. Altadena)
        const nearWild = letter === 'S' && wildDist !== null && wildDist[i] <= interfaceCells;
        if (irr && !nearWild) irrigated[i] = 1;
      }
      fuel[i] = k;
      if (k === NONE && (blueFrac[i] > 0.5 || e < 1)) blocked[i] = 1;

      const nx = c / W;
      const ny = row / H;
      const h = 0.65 * fbm(nx * 70 + 9, ny * 34 + 3, seed + 2, 4) + 0.35 * fbm(nx * 240, ny * 115, seed + 3, 2);
      hetero[i] = 0.6 + 0.8 * Math.min(1, Math.max(0, (h - 0.5) * 1.6 + 0.5));
    }
  }
  return { W, H, cellM: CELL_M, fuel, blocked, road, elev, hetero, windExp: windExposure(elev), structMult: structureSusceptibility(fuel, irrigated) };
}

/** Local relief (max-min elevation in a ~1.8 km window) -> wind exposure multiplier. */
function windExposure(elev: Float32Array): Float32Array {
  const B = 10; // block size in cells
  const bw = Math.ceil(W / B);
  const bh = Math.ceil(H / B);
  const bmin = new Float32Array(bw * bh).fill(Infinity);
  const bmax = new Float32Array(bw * bh).fill(-Infinity);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = ((r / B) | 0) * bw + ((c / B) | 0);
      const e = elev[r * W + c];
      if (e < bmin[k]) bmin[k] = e;
      if (e > bmax[k]) bmax[k] = e;
    }
  }
  const relief = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y < 0 || y >= bh || x < 0 || x >= bw) continue;
          lo = Math.min(lo, bmin[y * bw + x]);
          hi = Math.max(hi, bmax[y * bw + x]);
        }
      }
      relief[by * bw + bx] = hi - lo;
    }
  }
  const out = new Float32Array(W * H);
  const { WIND_EXPOSURE_MIN: m0, WIND_RELIEF_R0: r0, WIND_RELIEF_R1: r1 } = PHYS;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // bilinear between block centres for smoothness
      const fy = Math.min(bh - 1, Math.max(0, r / B - 0.5));
      const fx = Math.min(bw - 1, Math.max(0, c / B - 0.5));
      const y0 = Math.floor(fy);
      const x0 = Math.floor(fx);
      const y1 = Math.min(bh - 1, y0 + 1);
      const x1 = Math.min(bw - 1, x0 + 1);
      const ay = fy - y0;
      const ax = fx - x0;
      const rel =
        relief[y0 * bw + x0] * (1 - ax) * (1 - ay) + relief[y0 * bw + x1] * ax * (1 - ay) + relief[y1 * bw + x0] * (1 - ax) * ay + relief[y1 * bw + x1] * ax * ay;
      const t = Math.min(1, Math.max(0, (rel - r0) / (r1 - r0)));
      out[r * W + c] = m0 + (1 - m0) * t * t * (3 - 2 * t);
    }
  }
  return out;
}

/**
 * Per-cell spread multiplier from the ~650 m neighbourhood:
 * structures: more surrounding vegetation = more susceptible; vegetation: more surrounding built-up area
 * = irrigated urban greenery, much less flammable than wildland.
 */
function structureSusceptibility(fuel: Uint8Array, irrigated: Uint8Array): Float32Array {
  const R = 5;
  // summed-area table of vegetation cells
  const sat = new Float64Array((W + 1) * (H + 1));
  const bsat = new Float64Array((W + 1) * (H + 1));
  for (let r = 0; r < H; r++) {
    let row = 0;
    let brow = 0;
    for (let c = 0; c < W; c++) {
      const f = fuel[r * W + c];
      row += (f === GRASS || f === SHRUB || f === FOREST) && !irrigated[r * W + c] ? 1 : 0;
      brow += f === URBAN || f === CITY ? 1 : 0;
      sat[(r + 1) * (W + 1) + c + 1] = sat[r * (W + 1) + c + 1] + row;
      bsat[(r + 1) * (W + 1) + c + 1] = bsat[r * (W + 1) + c + 1] + brow;
    }
  }
  const out = new Float32Array(W * H);
  const { STRUCT_VEG_LO: lo, STRUCT_VEG_HI: hi, STRUCT_MIN_MULT: m0 } = PHYS;
  for (let r = 0; r < H; r++) {
    const r0 = Math.max(0, r - R);
    const r1 = Math.min(H, r + R + 1);
    for (let c = 0; c < W; c++) {
      const c0 = Math.max(0, c - R);
      const c1 = Math.min(W, c + R + 1);
      const area = (r1 - r0) * (c1 - c0);
      const veg = sat[r1 * (W + 1) + c1] - sat[r0 * (W + 1) + c1] - sat[r1 * (W + 1) + c0] + sat[r0 * (W + 1) + c0];
      const built = bsat[r1 * (W + 1) + c1] - bsat[r0 * (W + 1) + c1] - bsat[r1 * (W + 1) + c0] + bsat[r0 * (W + 1) + c0];
      const f = fuel[r * W + c];
      if (f === URBAN || f === CITY) {
        const t = Math.min(1, Math.max(0, (veg / area - lo) / (hi - lo)));
        out[r * W + c] = m0 + (1 - m0) * t * t * (3 - 2 * t);
      } else if (irrigated[r * W + c]) {
        out[r * W + c] = PHYS.URBAN_VEG_MULT; // irrigated parks, golf courses, yards
      } else {
        const t = Math.min(1, Math.max(0, (built / area - PHYS.URBAN_VEG_LO) / (PHYS.URBAN_VEG_HI - PHYS.URBAN_VEG_LO)));
        out[r * W + c] = 1 - (1 - PHYS.URBAN_VEG_MULT) * t * t * (3 - 2 * t);
      }
    }
  }
  return out;
}
