// Grid geometry, static arrays, and rasterization helpers. No DOM.
import { CENTER, W, H, CELL_M } from '../config.ts';

export interface StaticGrid {
  W: number;
  H: number;
  cellM: number;
  fuel: Uint8Array; // FUEL id per cell
  blocked: Uint8Array; // 1 = water/firebreak: never burns, embers can jump it
  road: Uint8Array; // 1 = road: only a fast head fire (ros >= ROAD_BREACH_ROS) crosses
  elev: Float32Array; // meters
  hetero: Float32Array; // 0.6..1.4 spread multiplier
  windExp?: Float32Array; // optional per-cell wind exposure multiplier (terrain sheltering)
  structMult?: Float32Array; // optional per-cell spread multiplier: structures = vegetation continuity, vegetation = urban irrigation
}

export interface LatLng {
  lat: number;
  lng: number;
}

const M_PER_DEG_LAT = 111320;
export const DLAT = CELL_M / M_PER_DEG_LAT;
export const DLNG = CELL_M / (M_PER_DEG_LAT * Math.cos((CENTER.lat * Math.PI) / 180));
export const NORTH = CENTER.lat + (H * DLAT) / 2;
export const SOUTH = CENTER.lat - (H * DLAT) / 2;
export const WEST = CENTER.lng - (W * DLNG) / 2;
export const EAST = CENTER.lng + (W * DLNG) / 2;

export function cellToLatLng(r: number, c: number): LatLng {
  return { lat: NORTH - (r + 0.5) * DLAT, lng: WEST + (c + 0.5) * DLNG };
}

/** Fractional cell coords (row, col) for a lat/lng; may be out of bounds. */
export function latLngToRC(lat: number, lng: number): { r: number; c: number } {
  return { r: (NORTH - lat) / DLAT - 0.5, c: (lng - WEST) / DLNG - 0.5 };
}

export function latLngToCell(lat: number, lng: number): { r: number; c: number } | null {
  const p = latLngToRC(lat, lng);
  const r = Math.round(p.r);
  const c = Math.round(p.c);
  if (r < 0 || r >= H || c < 0 || c >= W) return null;
  return { r, c };
}

/** Stamp a thick line from (r0,c0) to (r1,c1) into mask. radius in cells. */
export function stampLine(
  mask: Uint8Array,
  w: number,
  h: number,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  radius: number,
  value = 1,
): void {
  const len = Math.hypot(r1 - r0, c1 - c0);
  const steps = Math.max(1, Math.ceil(len * 2));
  const rad = Math.max(0.5, radius);
  const ri = Math.ceil(rad);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const rc = r0 + (r1 - r0) * t;
    const cc = c0 + (c1 - c0) * t;
    for (let dr = -ri; dr <= ri; dr++) {
      for (let dc = -ri; dc <= ri; dc++) {
        if (dr * dr + dc * dc > rad * rad) continue;
        const r = Math.round(rc + dr);
        const c = Math.round(cc + dc);
        if (r < 0 || r >= h || c < 0 || c >= w) continue;
        mask[r * w + c] = value;
      }
    }
  }
}

/** Stamp a polyline of lat/lng points as a band widthM wide. */
export function stampPolylineLatLng(mask: Uint8Array, pts: LatLng[], widthM: number): void {
  const radius = widthM / CELL_M / 2;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = latLngToRC(pts[k].lat, pts[k].lng);
    const b = latLngToRC(pts[k + 1].lat, pts[k + 1].lng);
    stampLine(mask, W, H, a.r, a.c, b.r, b.c, radius);
  }
}
