// Loads real terrain (AWS Terrarium elevation tiles) and Esri World Imagery for the grid box,
// and reduces them to per-cell features. Browser-only (uses canvas). No API keys.
import { H, W } from '../config.ts';
import { cellToLatLng, DLAT, DLNG } from '../sim/grid.ts';
import type { CellFeatures } from '../sim/landcover.ts';

const DEM_Z = 12; // ~32 m/px at LA
const IMG_Z = 13; // ~16 m/px at LA
const DEM_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_URL = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

function mercPx(lat: number, lng: number, z: number): [number, number] {
  const n = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

interface Mosaic {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  x0: number; // mercator pixel of mosaic (0,0)
  y0: number;
  failed: number;
  total: number;
}

async function loadMosaic(url: (z: number, x: number, y: number) => string, z: number, onTile: () => void): Promise<Mosaic> {
  // bounds of the grid box (+1 cell margin)
  const [xa, ya] = mercPx(cellToLatLng(-1, -1).lat, cellToLatLng(-1, -1).lng, z);
  const [xb, yb] = mercPx(cellToLatLng(H, W).lat, cellToLatLng(H, W).lng, z);
  const tx0 = Math.floor(Math.min(xa, xb) / 256);
  const tx1 = Math.floor(Math.max(xa, xb) / 256);
  const ty0 = Math.floor(Math.min(ya, yb) / 256);
  const ty1 = Math.floor(Math.max(ya, yb) / 256);
  const w = (tx1 - tx0 + 1) * 256;
  const h = (ty1 - ty0 + 1) * 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const jobs: [number, number][] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      try {
        const r = await fetch(url(z, tx, ty), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(String(r.status));
        const bmp = await createImageBitmap(await r.blob());
        ctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
        bmp.close();
      } catch {
        failed++;
      }
      onTile();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, x0: tx0 * 256, y0: ty0 * 256, failed, total: jobs.length };
}

/** Fetch and reduce real data to per-cell features. Throws if too many tiles fail. */
export async function loadRealFeatures(progress: (msg: string) => void): Promise<CellFeatures> {
  let done = 0;
  let total = 0;
  const tick = () => progress(`Loading terrain & imagery… ${++done}/${total || '?'} tiles`);
  // estimate total for the progress text
  const count = (z: number) => {
    const [xa, ya] = mercPx(cellToLatLng(-1, -1).lat, cellToLatLng(-1, -1).lng, z);
    const [xb, yb] = mercPx(cellToLatLng(H, W).lat, cellToLatLng(H, W).lng, z);
    return (Math.floor(xb / 256) - Math.floor(xa / 256) + 1) * (Math.floor(yb / 256) - Math.floor(ya / 256) + 1);
  };
  total = count(DEM_Z) + count(IMG_Z);
  const [dem, img] = await Promise.all([loadMosaic(DEM_URL, DEM_Z, tick), loadMosaic(IMG_URL, IMG_Z, tick)]);
  if (dem.failed > dem.total * 0.1 || img.failed > img.total * 0.1) {
    throw new Error(`tile loading failed (elevation ${dem.failed}/${dem.total}, imagery ${img.failed}/${img.total})`);
  }
  progress('Classifying fuels…');

  const n = W * H;
  const elev = new Float32Array(n);
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  const lumStd = new Float32Array(n);
  const blueFrac = new Float32Array(n);

  // Elevation: bilinear sample of Terrarium (elev = R*256 + G + B/256 - 32768)
  const demAt = (px: number, py: number) => {
    const x = Math.min(dem.w - 1, Math.max(0, Math.round(px)));
    const y = Math.min(dem.h - 1, Math.max(0, Math.round(py)));
    const k = (y * dem.w + x) * 4;
    return dem.data[k] * 256 + dem.data[k + 1] + dem.data[k + 2] / 256 - 32768;
  };
  // Imagery: 4x4 samples across each cell's footprint
  const S = 4;
  for (let row = 0; row < H; row++) {
    for (let c = 0; c < W; c++) {
      const i = row * W + c;
      const ll = cellToLatLng(row, c);
      const [dx, dy] = mercPx(ll.lat, ll.lng, DEM_Z);
      const fx = dx - dem.x0;
      const fy = dy - dem.y0;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      elev[i] =
        demAt(x0, y0) * (1 - ax) * (1 - ay) + demAt(x0 + 1, y0) * ax * (1 - ay) + demAt(x0, y0 + 1) * (1 - ax) * ay + demAt(x0 + 1, y0 + 1) * ax * ay;

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sl = 0;
      let sl2 = 0;
      let blue = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const lat = ll.lat + DLAT * ((sy + 0.5) / S - 0.5);
          const lng = ll.lng + DLNG * ((sx + 0.5) / S - 0.5);
          const [px, py] = mercPx(lat, lng, IMG_Z);
          const X = Math.min(img.w - 1, Math.max(0, Math.floor(px - img.x0)));
          const Y = Math.min(img.h - 1, Math.max(0, Math.floor(py - img.y0)));
          const k = (Y * img.w + X) * 4;
          const R = img.data[k];
          const G = img.data[k + 1];
          const B = img.data[k + 2];
          sr += R;
          sg += G;
          sb += B;
          const L = 0.299 * R + 0.587 * G + 0.114 * B;
          sl += L;
          sl2 += L * L;
          if (B > R + 8 && B >= G - 2) blue++;
        }
      }
      const m = S * S;
      r[i] = sr / m;
      g[i] = sg / m;
      b[i] = sb / m;
      const mean = sl / m;
      lumStd[i] = Math.sqrt(Math.max(0, sl2 / m - mean * mean));
      blueFrac[i] = blue / m;
    }
  }
  return { elev, r, g, b, lumStd, blueFrac };
}
