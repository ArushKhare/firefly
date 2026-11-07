// Official fire perimeter (GeoJSON) -> grid mask, and model-vs-real comparison. Pure. No DOM.
import { CELL_M, H, W } from '../config.ts';
import { cellToLatLng, latLngToRC } from './grid.ts';

type Ring = [number, number][]; // [lng, lat]
export interface PerimeterGeo {
  type: 'FeatureCollection';
  features: { geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] } }[];
}

function polygons(g: PerimeterGeo): Ring[][] {
  const out: Ring[][] = [];
  for (const f of g.features) {
    if (f.geometry.type === 'Polygon') out.push(f.geometry.coordinates as Ring[]);
    else out.push(...(f.geometry.coordinates as Ring[][]));
  }
  return out;
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 1 for grid cells whose centre is inside the perimeter (holes respected). */
export function rasterizePerimeter(g: PerimeterGeo): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (const poly of polygons(g)) {
    const outer = poly[0];
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const [lng, lat] of outer) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
    }
    const a = latLngToRC(maxLat, minLng);
    const b = latLngToRC(minLat, maxLng);
    for (let r = Math.max(0, Math.floor(a.r)); r <= Math.min(H - 1, Math.ceil(b.r)); r++) {
      for (let c = Math.max(0, Math.floor(a.c)); c <= Math.min(W - 1, Math.ceil(b.c)); c++) {
        const p = cellToLatLng(r, c);
        if (!inRing(p.lng, p.lat, outer)) continue;
        let hole = false;
        for (let h = 1; h < poly.length && !hole; h++) hole = inRing(p.lng, p.lat, poly[h]);
        if (!hole) mask[r * W + c] = 1;
      }
    }
  }
  return mask;
}

export interface Comparison {
  modelHa: number;
  realHa: number; // from the rasterized perimeter
  overlapPct: number; // intersection / union (IoU)
  caughtPct: number; // share of the real burn the model also burned
}

export function compare(arrival: Float32Array, t: number, mask: Uint8Array): Comparison {
  let m = 0;
  let r = 0;
  let both = 0;
  for (let i = 0; i < mask.length; i++) {
    const burned = arrival[i] <= t;
    if (burned) m++;
    if (mask[i]) {
      r++;
      if (burned) both++;
    }
  }
  const ha = (CELL_M * CELL_M) / 10000;
  const union = m + r - both;
  return { modelHa: m * ha, realHa: r * ha, overlapPct: union ? (100 * both) / union : 0, caughtPct: r ? (100 * both) / r : 0 };
}
