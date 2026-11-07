// Wind streaks (weather-map style): particles advected by the LOCAL wind, coloured by speed.
// The local wind includes terrain sheltering and the fire's own effects (indraft, collapse
// outflow, whirl swirls), so you can watch the fire bend the air around it.
import L from 'leaflet';
import { attachZoomAnim } from './zoomanim.ts';

const MPH = 2.23694;
const STOPS: [number, string][] = [
  [0, '#9cc4ff'],
  [10, '#6fe0a0'],
  [25, '#f5dc5c'],
  [40, '#ffaa3b'],
  [60, '#ff5a4f'],
  [80, '#e35cff'],
];
const bucket = (mph: number) => {
  let k = 0;
  for (let i = 0; i < STOPS.length; i++) if (mph >= STOPS[i][0]) k = i;
  return k;
};

interface Particle {
  x: number;
  y: number;
  age: number;
  max: number;
}

/** Local wind (m/s east, north, and how much the fire changed it) at a point, or null outside the model area. */
export type WindField = (lat: number, lng: number) => [number, number, number, boolean] | null; // 4th: over burned area
const FIRE_COLOR = '#fff1dc'; // streaks where the fire is bending the wind

export class WindLayer {
  private trails: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;
  private parts: Particle[] = [];
  private legend: HTMLElement;
  private badge: HTMLElement;
  enabled = true;
  private zoom: { zooming: () => boolean } = { zooming: () => false };

  constructor(
    private map: L.Map,
    private field: WindField,
  ) {
    const pane = map.createPane('wind');
    pane.style.zIndex = '455';
    pane.style.pointerEvents = 'none';
    this.trails = L.DomUtil.create('canvas', '', pane) as HTMLCanvasElement;
    this.tctx = this.trails.getContext('2d')!;
    // rebuild only when a pan/zoom ends; during a drag the canvas moves with the map
    this.zoom = attachZoomAnim(map, this.trails, () => this.reset());
    map.on('moveend resize viewreset', () => this.reset());
    this.badge = L.DomUtil.create('div', 'wind-badge', map.getContainer());
    this.badge.innerHTML = '<div class="wb-arrow">↑</div><div class="wb-text"></div>';
    this.legend = L.DomUtil.create('div', 'wind-legend', map.getContainer());
    this.legend.innerHTML =
      '<span>wind mph</span>' + STOPS.map(([v, c]) => `<i style="background:${c}"></i><b>${v}${v === 80 ? '+' : ''}</b>`).join('') + `<i style="background:${FIRE_COLOR}"></i><b>fire-driven</b>`;
    this.reset();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.trails.style.display = on ? '' : 'none';
    this.legend.style.display = on ? '' : 'none';
    this.badge.style.display = on ? '' : 'none';
  }

  /** Big on-map indicator: arrow points where the wind blows TO; text says where it comes FROM. */
  setBadge(fromDeg: number, fromName: string, mph: number, gustMph: number): void {
    (this.badge.firstElementChild as HTMLElement).style.transform = `rotate(${fromDeg + 180}deg)`;
    (this.badge.lastElementChild as HTMLElement).innerHTML = `<b>${Math.round(mph)} mph</b> from ${fromName}<br><span>gusts ${Math.round(gustMph)}</span>`;
  }

  private reset(): void {
    const s = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const c = this.trails;
    c.width = s.x * dpr;
    c.height = s.y * dpr;
    c.style.width = s.x + 'px';
    c.style.height = s.y + 'px';
    L.DomUtil.setPosition(c, this.map.containerPointToLayerPoint([0, 0]));
    this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(1700, Math.round((s.x * s.y) / 850));
    this.parts = Array.from({ length: n }, () => this.spawn(s.x, s.y, true));
  }

  private spawn(w: number, h: number, randomAge = false): Particle {
    const max = 60 + Math.random() * 90;
    return { x: Math.random() * w, y: Math.random() * h, age: randomAge ? Math.random() * max : 0, max };
  }

  /** Call every animation frame. */
  frame(): void {
    if (!this.enabled || this.zoom.zooming()) return;
    const s = this.map.getSize();
    const t = this.tctx;
    // fade old trails
    t.globalCompositeOperation = 'destination-in';
    t.fillStyle = 'rgba(0,0,0,0.93)'; // fade rate sets trail length
    t.fillRect(0, 0, s.x, s.y);
    t.globalCompositeOperation = 'source-over';
    t.lineWidth = 1.4;
    // batch segments by colour bucket
    const paths = STOPS.map(() => new Path2D());
    const firePath = new Path2D();
    const scarPath = new Path2D(); // segments over the burn scar: drawn faint so the scar stays visible
    for (const p of this.parts) {
      const ll = this.map.containerPointToLatLng([p.x, p.y]);
      const w = this.field(ll.lat, ll.lng);
      if (!w) {
        Object.assign(p, this.spawn(s.x, s.y));
        continue;
      }
      const sp = Math.hypot(w[0], w[1]);
      const k = 0.3; // px per frame per m/s (40 mph ~ 5 px/frame)
      const nx = p.x + w[0] * k;
      const ny = p.y - w[1] * k; // screen y points south
      const path = w[3] ? scarPath : w[2] > 1.1 ? firePath : paths[bucket(sp * MPH)];
      path.moveTo(p.x, p.y);
      path.lineTo(nx, ny);
      p.x = nx;
      p.y = ny;
      if (++p.age > p.max || nx < 0 || ny < 0 || nx > s.x || ny > s.y) Object.assign(p, this.spawn(s.x, s.y));
    }
    // light dark outline so streaks read on satellite and topo maps
    t.strokeStyle = 'rgba(0,0,0,0.25)';
    t.lineWidth = 3;
    paths.forEach((path) => t.stroke(path));
    t.stroke(firePath);
    t.lineWidth = 1.6;
    paths.forEach((path, k) => {
      t.strokeStyle = STOPS[k][1];
      t.globalAlpha = 0.7;
      t.stroke(path);
    });
    t.strokeStyle = FIRE_COLOR;
    t.globalAlpha = 0.8;
    t.lineWidth = 2;
    t.stroke(firePath);
    // over the burn scar: thin and faint
    t.strokeStyle = 'rgba(255,255,255,0.18)';
    t.globalAlpha = 1;
    t.lineWidth = 1;
    t.stroke(scarPath);
    t.globalAlpha = 1;
  }
}
