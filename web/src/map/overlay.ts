// Canvas rendering of terrain/fuel and fire onto the Leaflet map.
// Rendering never runs the solver; it only reads the arrival field.
import L from 'leaflet';
import { CITY, FUELS, NONE, RENDER, ROAD_COLOR } from '../config.ts';
import { EAST, NORTH, SOUTH, WEST, type StaticGrid } from '../sim/grid.ts';
import type { SolveResult } from '../sim/solver.ts';
import { attachZoomAnim } from './zoomanim.ts';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pack = (r: number, g: number, b: number, a: number) =>
  ((a & 255) << 24) | ((Math.min(255, Math.max(0, b)) & 255) << 16) | ((Math.min(255, Math.max(0, g)) & 255) << 8) | (Math.min(255, Math.max(0, r)) & 255);

const FLAME_LO = hex('#b3261e');
const FLAME_MID = hex('#ff7a1a');
const FLAME_HI = hex('#ffe9a8');
const EMBER = hex('#e0561b');
const EMBER_DARK = hex('#4a1410');
const EMBER_BRIGHT = hex('#ffb347');
const SCAR = hex('#1b1715');
const ASH = hex('#4a4643');

export interface MapEvent {
  r: number; // fractional row/col
  c: number;
  age: number; // minutes since event
  kind: 'spot' | 'whirl' | 'collapse' | 'breach';
}

export interface FrameStats {
  burnedCells: number;
  activeCells: number; // flame front
  headRos: number; // m/min, max over cells ignited in last 10 min
  spotsSoFar: number;
}

export class FireOverlay {
  private terrain: HTMLCanvasElement;
  private fire: HTMLCanvasElement;
  private fireCtx: CanvasRenderingContext2D;
  private fireImg: ImageData;
  private firePx: Uint32Array;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private flameLUT = new Uint32Array(256);
  private textureLUT: Float32Array; // per-cell texture factor from hetero
  private residence: Float32Array;

  constructor(
    private map: L.Map,
    private grid: StaticGrid,
  ) {
    const { W, H } = grid;
    this.terrain = document.createElement('canvas');
    this.terrain.width = W;
    this.terrain.height = H;
    this.fire = document.createElement('canvas');
    this.fire.width = W;
    this.fire.height = H;
    this.fireCtx = this.fire.getContext('2d')!;
    this.fireImg = this.fireCtx.createImageData(W, H);
    this.firePx = new Uint32Array(this.fireImg.data.buffer);

    for (let k = 0; k < 256; k++) {
      const t = k / 255;
      const c = t < 0.5 ? lerp3(FLAME_LO, FLAME_MID, t * 2) : lerp3(FLAME_MID, FLAME_HI, (t - 0.5) * 2);
      this.flameLUT[k] = pack(c[0], c[1], c[2], 255);
    }
    this.textureLUT = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) this.textureLUT[i] = 0.82 + 0.36 * ((grid.hetero[i] - 0.6) / 0.8);
    this.residence = new Float32Array(FUELS.map((f) => Math.max(1, f.residence)));

    this.drawTerrain();

    // Map-sized canvas in its own pane, redrawn on move and every frame.
    const pane = map.createPane('fire');
    pane.style.zIndex = '450';
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'fire-canvas', pane) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.zoom = attachZoomAnim(map, this.canvas, () => this.draw());
    map.on('move resize viewreset', () => this.draw());
    this.resize();
    map.on('resize', () => this.resize());
  }

  private resize(): void {
    const s = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = s.x * dpr;
    this.canvas.height = s.y * dpr;
    this.canvas.style.width = s.x + 'px';
    this.canvas.style.height = s.y + 'px';
    this.draw();
  }

  /** Fuel color x hetero texture x hillshade (sun from NW). Drawn once. */
  private drawTerrain(): void {
    const { W, H, fuel, road, elev, cellM, blocked } = this.grid;
    const ctx = this.terrain.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const colors = FUELS.map((f) => hex(f.color));
    const roadC = hex(ROAD_COLOR);
    // light vector toward the sun: azimuth 315 (NW), altitude 45
    const Le = -0.5;
    const Ln = 0.5;
    const Lu = Math.SQRT1_2;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const e1 = elev[r * W + Math.min(W - 1, c + 1)];
        const e0 = elev[r * W + Math.max(0, c - 1)];
        const s1 = elev[Math.min(H - 1, r + 1) * W + c];
        const s0 = elev[Math.max(0, r - 1) * W + c];
        const dzdE = (e1 - e0) / (2 * cellM);
        const dzdN = -(s1 - s0) / (2 * cellM);
        const exag = 1.5;
        const nx = -dzdE * exag;
        const ny = -dzdN * exag;
        const len = Math.hypot(nx, ny, 1);
        const shade = Math.max(0, (nx * Le + ny * Ln + Lu) / len);
        const k = 0.5 + 0.75 * shade;
        let col: RGB;
        let tex = this.textureLUT[i];
        if (fuel[i] === NONE || blocked[i]) {
          col = colors[NONE];
          tex = 1;
        } else if (road[i]) {
          col = roadC;
          tex = 1;
        } else col = colors[fuel[i]];
        const alpha = RENDER.HIDE_CITY_TINT && fuel[i] === CITY ? 0 : 255;
        px[i] = pack(col[0] * k * tex, col[1] * k * tex, col[2] * k * tex, alpha);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Recolor fire canvas for sim time t. Returns live stats from the same pass. */
  /** Cells drawn as control line (containment). */
  contained: Uint8Array | null = null;

  renderFire(res: SolveResult | null, t: number): FrameStats {
    const px = this.firePx;
    const stats: FrameStats = { burnedCells: 0, activeCells: 0, headRos: 0, spotsSoFar: 0 };
    if (!res) {
      px.fill(0);
      this.fireCtx.putImageData(this.fireImg, 0, 0);
      return stats;
    }
    const { arrival, ros, spotted } = res;
    const fuel = this.grid.fuel;
    const tex = this.textureLUT;
    const resid = this.residence;
    const flameMin = RENDER.FLAME_MIN;
    const rosScale = 255 / RENDER.ROS_HOT;
    const scarFade = RENDER.SCAR_FADE_MIN;
    const n = arrival.length;
    for (let i = 0; i < n; i++) {
      const a = arrival[i];
      if (!(a <= t)) {
        px[i] = 0;
        continue;
      }
      stats.burnedCells++;
      const age = t - a;
      if (age < 10 && ros[i] > stats.headRos) stats.headRos = ros[i];
      if (spotted[i]) stats.spotsSoFar++;
      if (age < flameMin) {
        stats.activeCells++;
        const base = this.flameLUT[Math.min(255, (ros[i] * rosScale) | 0)];
        const fl = 0.85 + 0.3 * Math.random();
        // spot fires get a bright ring-ish boost when fresh
        const boost = spotted[i] && age < 1.5 ? 1.35 : 1;
        const k = fl * boost;
        px[i] = pack((base & 255) * k, ((base >> 8) & 255) * k, ((base >> 16) & 255) * k, 255);
        continue;
      }
      const res_ = resid[fuel[i]];
      if (age < flameMin + res_) {
        const s = (age - flameMin) / res_;
        if (Math.random() < 0.04 * (1 - s)) {
          px[i] = pack(EMBER_BRIGHT[0], EMBER_BRIGHT[1], EMBER_BRIGHT[2], 255);
        } else {
          const c = lerp3(EMBER, EMBER_DARK, Math.sqrt(s));
          px[i] = pack(c[0], c[1], c[2], 240);
        }
        continue;
      }
      const s = Math.min(1, (age - flameMin - res_) / scarFade);
      const k = tex[i];
      px[i] = pack((SCAR[0] + (ASH[0] - SCAR[0]) * s) * k, (SCAR[1] + (ASH[1] - SCAR[1]) * s) * k, (SCAR[2] + (ASH[2] - SCAR[2]) * s) * k, 215);
    }
    const cont = this.contained;
    if (cont) for (let i = 0; i < n; i++) if (cont[i]) px[i] = pack(255, 255, 255, 255);
    this.fireCtx.putImageData(this.fireImg, 0, 0);
    return stats;
  }

  events: MapEvent[] = [];
  showFuel = true;
  fuelOpacity = RENDER.TERRAIN_OPACITY;

  private zoom: { zooming: () => boolean } = { zooming: () => false };

  /** Composite terrain + fire onto the map canvas, then event rings. */
  draw(): void {
    if (this.zoom.zooming()) return; // canvas is being scaled by the zoom animation
    const map = this.map;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = map.getSize();
    ctx.clearRect(0, 0, s.x, s.y);
    const nw = map.latLngToContainerPoint([NORTH, WEST]);
    const se = map.latLngToContainerPoint([SOUTH, EAST]);
    const w = se.x - nw.x;
    const h = se.y - nw.y;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.showFuel) {
      ctx.globalAlpha = this.fuelOpacity;
      ctx.drawImage(this.terrain, nw.x, nw.y, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(this.fire, nw.x, nw.y, w, h);
    // event rings: spot fires (orange), fire whirls (cyan), column collapse (white, large)
    const pxPerCell = w / this.grid.W;
    for (const e of this.events) {
      const x = nw.x + ((e.c + 0.5) / this.grid.W) * w;
      const y = nw.y + ((e.r + 0.5) / this.grid.H) * h;
      const life = e.kind === 'collapse' ? 15 : e.kind === 'breach' ? 6 : 3;
      const f = Math.min(1, e.age / life);
      const base = e.kind === 'collapse' ? 60 : e.kind === 'whirl' ? 6 : 4;
      const grow = e.kind === 'collapse' ? (1000 / 20) * f : 12 * f;
      const rad = Math.max(6, (base + grow) * pxPerCell);
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.lineWidth = e.kind === 'collapse' ? 3 : 2;
      ctx.strokeStyle =
        e.kind === 'collapse'
          ? `rgba(255,255,255,${0.9 * (1 - f) + 0.1})`
          : e.kind === 'whirl'
            ? `rgba(90,230,255,${1 - f})`
            : e.kind === 'breach'
              ? `rgba(255,40,60,${1 - f})`
              : `rgba(255,190,90,${1 - f})`;
      if (e.kind === 'breach') ctx.lineWidth = 3;
      if (e.kind === 'collapse') ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
