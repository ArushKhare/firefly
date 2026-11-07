// "Relief & contours" overlay computed in the browser from real elevation tiles
// (AWS Terrain Tiles / Terrarium; USGS 3DEP in the US). Hillshade + contour lines at the map's own
// zoom, so it stays sharp and accurate as you zoom in (native data to z15, ~5 m/px here).
import L from 'leaflet';

const MAX_NATIVE = 15;
const url = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Contour interval (m) by zoom; index contours every 5th line. */
function interval(z: number): number {
  if (z <= 10) return 200;
  if (z <= 11) return 100;
  if (z <= 12) return 50;
  if (z <= 13) return 25;
  if (z <= 14) return 20;
  return 10;
}

async function elevationTile(z: number, x: number, y: number): Promise<Float32Array> {
  const nz = Math.min(z, MAX_NATIVE);
  const dz = z - nz;
  const sub = 1 << dz;
  const tx = Math.floor(x / sub);
  const ty = Math.floor(y / sub);
  const r = await fetch(url(nz, tx, ty));
  if (!r.ok) throw new Error(String(r.status));
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(256, 256);
  const ctx = c.getContext('2d')!;
  // over-zoom: draw the relevant sub-square of the parent tile scaled up
  const s = 256 / sub;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bmp, (x % sub) * s, (y % sub) * s, s, s, 0, 0, 256, 256);
  bmp.close();
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const e = new Float32Array(256 * 256);
  for (let i = 0; i < e.length; i++) {
    const v = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    e[i] = v < -100 ? 0 : v; // ocean no-data
  }
  return e;
}

export type ReliefTheme = 'light' | 'dark';

export function reliefLayer(): L.GridLayer & { setTheme(t: ReliefTheme): void } {
  let theme: ReliefTheme = 'light';
  const Relief = L.GridLayer.extend({
    createTile(coords: L.Coords, done: L.DoneCallback) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      elevationTile(coords.z, coords.x, coords.y)
        .then((e) => {
          const ctx = tile.getContext('2d')!;
          const img = ctx.createImageData(256, 256);
          const px = img.data;
          // metres per pixel at this tile's latitude
          const n = 2 ** coords.z;
          const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (coords.y + 0.5)) / n)));
          const mpp = (156543.03 * Math.cos(lat)) / n;
          const I = interval(coords.z);
          // light from the NW, 45 deg up
          const Le = -0.5;
          const Ln = 0.5;
          const Lu = Math.SQRT1_2;
          for (let yy = 0; yy < 256; yy++) {
            for (let xx = 0; xx < 256; xx++) {
              const i = yy * 256 + xx;
              const xl = e[yy * 256 + Math.max(0, xx - 1)];
              const xr = e[yy * 256 + Math.min(255, xx + 1)];
              const yu = e[Math.max(0, yy - 1) * 256 + xx];
              const yd = e[Math.min(255, yy + 1) * 256 + xx];
              const dzdE = (xr - xl) / (2 * mpp);
              const dzdN = (yu - yd) / (2 * mpp);
              const len = Math.hypot(dzdE, dzdN, 1);
              const shade = (-dzdE * Le - dzdN * Ln + Lu) / len; // 0..1
              let r = 0;
              let g = 0;
              let b = 0;
              let a = 0;
              if (shade < 0.72) {
                a = Math.min(theme === 'dark' ? 0.45 : 0.6, (0.72 - shade) * 1.1); // shadow
              } else {
                r = g = b = theme === 'dark' ? 200 : 255;
                a = Math.min(theme === 'dark' ? 0.14 : 0.28, (shade - 0.72) * 0.9); // highlight
              }
              // contour: band changes between this pixel and its right/down neighbour
              const k = Math.floor(e[i] / I);
              const kr = Math.floor(xr / I);
              const kd = Math.floor(yd / I);
              if (k !== kr || k !== kd) {
                const level = Math.max(k, kr, kd);
                const index = level % 5 === 0;
                if (theme === 'dark') {
                  // chart-style cyan contours on the dark map
                  r = 80;
                  g = 170;
                  b = 210;
                  a = index ? 0.7 : 0.32;
                } else {
                  r = 110;
                  g = 62;
                  b = 20;
                  a = index ? 0.9 : 0.55;
                }
              }
              px[i * 4] = r;
              px[i * 4 + 1] = g;
              px[i * 4 + 2] = b;
              px[i * 4 + 3] = a * 255;
            }
          }
          ctx.putImageData(img, 0, 0);
          done(undefined, tile);
        })
        .catch((err) => done(err as Error, tile));
      return tile;
    },
  });
  const layer = new (Relief as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({
    maxZoom: 19,
    opacity: 0.9,
    attribution: 'Relief: AWS Terrain Tiles (USGS 3DEP)',
  }) as L.GridLayer & { setTheme(t: ReliefTheme): void };
  layer.setTheme = (t: ReliefTheme) => {
    if (t === theme) return;
    theme = t;
    layer.redraw();
  };
  return layer;
}
