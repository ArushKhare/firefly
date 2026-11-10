// Evacuation zones: a hex tessellation of all land in the Southern California megaregion.
// Every land point falls in exactly one zone. Pure (shared by browser and server), no DOM.
import { HEX, ZONE_ROWS } from './zonesData.ts';

export interface ZoneDef {
  id: string;
  name: string;
  lat: number; // hex centre
  lng: number;
  radiusM: number; // hex circumradius
  clearanceMin: number; // estimated evacuation clearance time (terrain-based); approximate
  q: number; // axial hex coords
  r: number;
}

export const REGION = { north: HEX.north, south: HEX.south, west: HEX.west, east: HEX.east };

const KX = 111320 * Math.cos((HEX.lat0 * Math.PI) / 180);
const KY = 111320;
const R = HEX.radiusM;
const SQ3 = Math.sqrt(3);

const toXY = (lat: number, lng: number) => [(lng - HEX.lng0) * KX, (lat - HEX.lat0) * KY];
const toLL = (x: number, y: number) => ({ lat: HEX.lat0 + y / KY, lng: HEX.lng0 + x / KX });

export const ZONES: ZoneDef[] = ZONE_ROWS.map(([q, r, id, name, clearanceMin]) => {
  const c = toLL(R * SQ3 * (q + r / 2), R * 1.5 * r);
  return { id, name, lat: c.lat, lng: c.lng, radiusM: R, clearanceMin, q, r };
});

const byKey = new Map<number, number>();
const key = (q: number, r: number) => (q + 4096) * 8192 + (r + 4096);
ZONES.forEach((z, k) => byKey.set(key(z.q, z.r), k));
const byId = new Map(ZONES.map((z) => [z.id, z]));

export const zoneById = (id: string): ZoneDef | undefined => byId.get(id);

/** Index into ZONES of the zone containing this point, or -1 (ocean / outside the region). */
export function zoneIndexAt(lat: number, lng: number): number {
  const [x, y] = toXY(lat, lng);
  const fq = ((SQ3 / 3) * x - y / 3) / R;
  const fr = ((2 / 3) * y) / R;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return byKey.get(key(q, r)) ?? -1;
}

/** Hex outline as [lat, lng] pairs (pointy-top). */
export function zonePolygon(z: ZoneDef): [number, number][] {
  const cx = R * SQ3 * (z.q + z.r / 2);
  const cy = R * 1.5 * z.r;
  const out: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    const p = toLL(cx + R * Math.cos(a), cy + R * Math.sin(a));
    out.push([p.lat, p.lng]);
  }
  return out;
}
