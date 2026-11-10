// Bootstrap: map, terrain, simulator, overlay, controls, animation loop.
import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { CENTER, CELL_M, DEMO_MODE, ENSEMBLE_N, FIREWX, HA_TO_ACRES, PHYS, PLAYBACK, RENDER, SCENARIOS, SEED, W, ZONES } from './config.ts';
import { EAST, NORTH, SOUTH, WEST, cellToLatLng } from './sim/grid.ts';
import { generateTerrain } from './sim/terrain.ts';
import { classify, visionPerCell, type VisionLandcover } from './sim/landcover.ts';
import { loadRealFeatures } from './map/realdata.ts';
import { SolverClient, Simulator } from './sim/simulator.ts';
import { crownFactor, envAt, weatherAt } from './sim/ros.ts';
import { FireOverlay, type MapEvent } from './map/overlay.ts';
import { WindLayer } from './map/wind.ts';
import { reliefLayer } from './map/relief.ts';
import { latLngToCell } from './sim/grid.ts';
import { fireWindAt, type FireWxSample } from './sim/firewx.ts';
import { summarise, zoneCells, zoneStats, type EnsembleResult } from './sim/metrics.ts';
import { Controls } from './ui/controls.ts';
import { WarningsPanel } from './ui/warnings.ts';
import { minutesToOrder, assignTiers, type ZoneSituation } from './warnings.ts';
import { latLngToRC } from './sim/grid.ts';
import { fetchLiveWeather, historicalSchedule, presetSchedule, type WeatherSchedule } from './weather.ts';
import { compare, rasterizePerimeter, type Comparison, type PerimeterGeo } from './sim/perimeter.ts';
import { clusterBreaches, computeResponse, type ResponseState } from './response.ts';
import type { ScenarioKey } from './config.ts';
import { degToCompass, fmtDuration, mpsToMph } from './units.ts';

if (DEMO_MODE) document.body.classList.add('demo');

// ---------- Map ----------
const map = L.map('map', {
  zoomControl: true,
  zoomSnap: 0.25, // smoother wheel zoom: quarter levels
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 100,
  wheelDebounceTime: 20,
}).setView([CENTER.lat, CENTER.lng], 11);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18,
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
});
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap contributors',
});
const esriTopo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18,
  attribution: 'Topo © Esri, USGS, NOAA',
});
const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors, SRTM',
});
const relief = reliefLayer();

// Dark "aviation chart" basemap: Esri Dark Gray Canvas streets (no API key), labels drawn ABOVE the fire
// so names stay readable, plus a faint lat/long grid with coordinate ticks.
map.createPane('labels');
map.getPane('labels')!.style.zIndex = '470';
map.getPane('labels')!.style.pointerEvents = 'none';
const darkStreets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16,
  attribution: 'Base © Esri, HERE, Garmin, © OpenStreetMap contributors',
});
const darkLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16,
  pane: 'labels',
});
const graticule = L.layerGroup();
{
  const step = 0.05;
  const style = { color: '#5aa9ff', weight: 1, opacity: 0.22, dashArray: '2 6', interactive: false };
  for (let lat = Math.ceil(SOUTH / step) * step; lat <= NORTH; lat += step) {
    L.polyline([[lat, WEST], [lat, EAST]], style).addTo(graticule);
    L.marker([lat, WEST], {
      interactive: false,
      icon: L.divIcon({ className: 'grat-label', html: `${lat.toFixed(2)}°N`, iconSize: [60, 14], iconAnchor: [-4, 7] }),
    }).addTo(graticule);
  }
  for (let lng = Math.ceil(WEST / step) * step; lng <= EAST; lng += step) {
    L.polyline([[SOUTH, lng], [NORTH, lng]], style).addTo(graticule);
    L.marker([NORTH, lng], {
      interactive: false,
      icon: L.divIcon({ className: 'grat-label', html: `${Math.abs(lng).toFixed(2)}°W`, iconSize: [64, 14], iconAnchor: [32, -4] }),
    }).addTo(graticule);
  }
}
const darkChart = L.layerGroup([darkStreets, darkLabels, graticule]);
const fuelTint = L.layerGroup(); // toggles the fuel colour tint drawn by the fire overlay
satellite.addTo(map);
relief.addTo(map);
fuelTint.addTo(map);
L.control
  .layers(
    DEMO_MODE
      ? { Satellite: satellite, 'Dark chart (streets)': darkChart, Topographic: esriTopo }
      : { Satellite: satellite, 'Dark chart (streets)': darkChart, 'Topographic (Esri)': esriTopo, 'Topographic (OpenTopoMap)': openTopo, Streets: osm },
    { 'Relief & contours (USGS 3DEP)': relief, 'Fuel map tint': fuelTint },
    { position: 'topleft' },
  )
  .addTo(map);
L.rectangle([[SOUTH, WEST], [NORTH, EAST]], { color: '#ff7a1a', weight: 1, fill: false, dashArray: '4 6', interactive: false }).addTo(map);
map.fitBounds([[SOUTH, WEST], [NORTH, EAST]], { padding: [10, 10] });

// ---------- Terrain & fuel: real LA data, synthetic fallback so the demo never breaks ----------
const loadingEl = document.getElementById('loading')!;
let dataNote = 'Real terrain (AWS) + fuels from Esri imagery';
async function loadGrid() {
  try {
    const t0 = performance.now();
    const [f, vision] = await Promise.all([
      loadRealFeatures((msg) => (loadingEl.textContent = msg)),
      fetch('/landcover/vision_la.json')
        .then((r) => (r.ok ? (r.json() as Promise<VisionLandcover>) : null))
        .catch(() => null),
    ]);
    const g = classify(f, SEED, vision ? visionPerCell(vision) : undefined);
    if (vision) dataNote = `Real terrain (USGS 3DEP via AWS) + fuels from Esri imagery, checked block-by-block by a vision model (${(vision as VisionLandcover & { model?: string }).model ?? 'OpenRouter'})`;
    console.info(`[data] real LA grid in ${(performance.now() - t0).toFixed(0)} ms`);
    return g;
  } catch (err) {
    console.warn('real data failed, using synthetic terrain', err);
    dataNote = 'Synthetic terrain (real data failed to load)';
    return generateTerrain(SEED);
  }
}
const grid = await loadGrid();
loadingEl.remove();

// ---------- Sim ----------
const zCells = zoneCells(grid);
const client = new SolverClient(grid, zCells);
const ensembleClient = new SolverClient(grid, zCells); // separate worker so uncertainty runs never block the live solve
const sim = new Simulator(grid, client);
let ensemble: { res: EnsembleResult; atSimTime: number } | null = null;
let ensembleSeq = 0;
let ensembleRunning = false;
const overlay = new FireOverlay(map, grid);
// dark chart: chart-style relief colours and a lighter fuel tint
map.on('baselayerchange', (e) => {
  const dark = (e as L.LayersControlEvent).layer === darkChart;
  relief.setTheme(dark ? 'dark' : 'light');
  overlay.fuelOpacity = dark ? 0.18 : RENDER.TERRAIN_OPACITY;
  map.getContainer().classList.toggle('dark-chart', dark);
});
map.on('overlayadd', (e) => {
  if ((e as L.LayersControlEvent).layer === fuelTint) overlay.showFuel = true;
});
map.on('overlayremove', (e) => {
  if ((e as L.LayersControlEvent).layer === fuelTint) overlay.showFuel = false;
});

// Elevation / slope / fuel readout under the cursor (from the model's terrain grid)
const elevBox = L.DomUtil.create('div', 'elev-box', map.getContainer());
if (DEMO_MODE) elevBox.setAttribute('data-demo-hide', '');
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  const rc = latLngToCell(e.latlng.lat, e.latlng.lng);
  if (!rc) {
    elevBox.style.display = 'none';
    return;
  }
  const i = rc.r * W + rc.c;
  const z = (r: number, c: number) => grid.elev[Math.min(grid.H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))];
  const dx = (z(rc.r, rc.c + 1) - z(rc.r, rc.c - 1)) / (2 * CELL_M);
  const dy = (z(rc.r + 1, rc.c) - z(rc.r - 1, rc.c)) / (2 * CELL_M);
  const slope = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  const fuelName = ['water', 'grass', 'chaparral', 'dense brush/trees', 'homes in vegetation', 'dense city'][grid.fuel[i]] ?? '';
  elevBox.style.display = '';
  elevBox.textContent = `${Math.round(grid.elev[i])} m (${Math.round(grid.elev[i] * 3.281)} ft) · slope ${slope.toFixed(0)}° · ${fuelName}`;
});
map.on('mouseout', () => (elevBox.style.display = 'none'));
// Local wind for the streaks: ambient x terrain exposure, plus the fire's own wind
// (indraft, collapse outflow) and a short-lived swirl around fire whirls.
let windNow: { U: number; tE: number; tN: number; wx: FireWxSample | null; whirls: { r: number; c: number; age: number }[] } | null = null;
const windLayer = new WindLayer(map, (lat, lng) => {
  const rc = latLngToCell(lat, lng);
  if (!rc || !windNow) return null;
  const exp = grid.windExp ? grid.windExp[rc.r * W + rc.c] : 1;
  const { U, tE, tN, wx } = windNow;
  const ae = U * exp * tE;
  const an = U * exp * tN;
  let [we, wn] = wx && sim.fireWx ? fireWindAt(wx, sim.simTime, U, tE, tN, exp, rc.r, rc.c, CELL_M) : [ae, an];
  for (const w of windNow.whirls) {
    const dx = (rc.c - w.c) * CELL_M;
    const dy = -(rc.r - w.r) * CELL_M;
    const d = Math.hypot(dx, dy);
    if (d > 1 && d < 600) {
      const v = 12 * Math.exp(-d / 180) * (1 - w.age / 4); // tangential, counter-clockwise
      we += (-dy / d) * v;
      wn += (dx / d) * v;
    }
  }
  const burned = !!sim.result && sim.result.arrival[rc.r * W + rc.c] <= sim.simTime;
  return [we, wn, Math.hypot(we - ae, wn - an), burned];
});
const windToggle = document.getElementById('wind-toggle') as HTMLInputElement;
windToggle.onchange = () => windLayer.setEnabled(windToggle.checked);
const airToggle = document.getElementById('air-toggle') as HTMLInputElement;
airToggle.onchange = () => {
  sim.airAttack = airToggle.checked;
  if (sim.ignitions.length) void recompute();
};
const urbanSel = document.getElementById('urban-spread') as HTMLSelectElement;
urbanSel.onchange = () => {
  sim.urbanMult = PHYS.URBAN_SPREAD[urbanSel.value] ?? 1;
  if (sim.ignitions.length) void recompute();
};

const zoneLayers = ZONES.map((z) =>
  L.circle([z.lat, z.lng], { radius: z.radiusM, color: '#7fc4ff', weight: 2, fillOpacity: 0.05, interactive: false })
    .addTo(map)
    .bindTooltip(`Zone ${z.id}: ${z.name}`, { permanent: true, direction: 'center', className: 'zone-label' }),
);

async function runEnsemble(): Promise<void> {
  const seq = ++ensembleSeq;
  ensembleRunning = true;
  try {
    const at = sim.simTime;
    const res = await sim.ensemble(ensembleClient, ENSEMBLE_N);
    if (seq !== ensembleSeq) return;
    ensemble = res ? { res, atSimTime: at } : null;
    if (res) console.info(`[ensemble] ${res.members} runs in ${res.ms.toFixed(0)} ms`);
  } catch (e) {
    console.error('ensemble failed', e);
  } finally {
    if (seq === ensembleSeq) ensembleRunning = false;
  }
}

// ---------- State ----------
let playing = false;
let speed = PLAYBACK.DEFAULT_SPEED;
let schedule: WeatherSchedule = presetSchedule('fallback');
let computing = false;
let lastSolveMs = 0;
let simStartWall = new Date(); // wall-clock time at sim t = 0
/** Set the sim's wall-clock start. Aircraft fly by daylight in the fire's own time zone (Pacific). */
function setStartWall(d: Date, fireLocal = false): void {
  simStartWall = d;
  if (fireLocal) {
    sim.clockStartMin = d.getHours() * 60 + d.getMinutes(); // historical: already the fire's local time
    return;
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const get = (k: string) => Number(parts.find((x) => x.type === k)?.value ?? 0);
  sim.clockStartMin = get('hour') * 60 + get('minute');
}
setStartWall(simStartWall);

async function recompute(): Promise<void> {
  computing = true;
  try {
    const ok = await sim.compute();
    if (ok && sim.result) {
      lastSolveMs = sim.result.ms;
      console.info(`[solver] ${sim.result.ms.toFixed(0)} ms, ${sim.result.spots.length} spot fires, horizon ${sim.result.horizon.toFixed(0)} min`);
      void runEnsemble();
    }
  } catch (e) {
    console.error('solve failed', e);
  } finally {
    computing = false;
  }
  repaint();
}

function repaint(): void {
  lastPanel = 0;
  const stats = overlay.renderFire(sim.result, sim.simTime);
  overlay.draw();
  updatePanel(stats);
}

type WxChoice = 'live' | 'redflag' | 'hotstill' | 'santaana' | 'historical';
let wxSeq = 0;
async function loadWeather(src: WxChoice): Promise<void> {
  const seq = ++wxSeq; // only the latest weather choice wins (live fetch can finish after a preset)
  const note = document.getElementById('wx-note')!;
  note.textContent = src === 'live' ? 'loading…' : '';
  const next =
    src === 'live'
      ? await fetchLiveWeather(CENTER.lat, CENTER.lng)
      : src === 'historical'
        ? await historicalSchedule(scenario ?? 'eaton', SCENARIOS[scenario ?? 'eaton'].start, SCENARIOS[scenario ?? 'eaton'].windDirOffset)
        : presetSchedule(src);
  if (seq !== wxSeq) return;
  schedule = next;
  // Schedule minutes are relative to "now"; shift so they line up with current sim time.
  const t = sim.simTime;
  const shift = src === 'historical' ? 0 : t; // historical points are already relative to ignition
  sim.setWindSchedule(schedule.points.map((p) => ({ ...p, atMinute: p.atMinute + shift })));
  const w0 = schedule.points[0];
  note.textContent =
    schedule.source === 'live' && w0.speedMps < 4
      ? `${schedule.note} · light wind now, try Red-flag preset`
      : schedule.note;
  if (sim.ignitions.length) await recompute();
}

// ---------- Controls ----------
const controls = new Controls({
  onPlayToggle() {
    playing = !playing;
    controls.setPlaying(playing);
  },
  onSpeed(s) {
    speed = s;
  },
  onReset() {
    sim.reset();
    warnings.reset();
    scenario = null;
    perimeterLayer?.remove();
    perimeterLayer = null;
    perimeterMask = null;
    lastCompare = null;
    ensemble = null;
    ensembleSeq++;
    setStartWall(new Date());
    playing = false;
    controls.setPlaying(false);
    const sel = document.getElementById('wx-source') as HTMLSelectElement;
    void loadWeather(sel.value as WxChoice);
  },
  onIgniteToggle(on) {
    map.getContainer().classList.toggle('igniting', on);
  },
  onWeatherSource(src) {
    void loadWeather(src);
  },
});
map.getContainer().classList.add('igniting');

map.on('click', async (e: L.LeafletMouseEvent) => {
  if (!controls.igniteOn) return;
  // a small 3-cell cluster so the start is visible
  const d = CELL_M / 111320;
  const pts = [
    { lat: e.latlng.lat, lng: e.latlng.lng },
    { lat: e.latlng.lat + d, lng: e.latlng.lng },
    { lat: e.latlng.lat, lng: e.latlng.lng + d * 1.3 },
  ];
  if (sim.ignite(pts) === 0) return;
  await recompute();
  if (!playing) {
    playing = true;
    controls.setPlaying(true);
  }
});

// ---------- Fire weather ----------
const fwxToggle = document.getElementById('fwx-toggle') as HTMLInputElement;
fwxToggle.checked = sim.fireWx;
fwxToggle.onchange = () => {
  sim.fireWx = fwxToggle.checked;
  if (sim.ignitions.length) void recompute();
};

function wxAt(t: number): FireWxSample | null {
  const tl = sim.result?.fireWx;
  if (!tl || tl.length === 0 || tl[0].t > t) return null;
  let lo = 0;
  let hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return tl[lo];
}

function collectEvents(t: number): MapEvent[] {
  const res = sim.result;
  if (!res) return [];
  const ev: MapEvent[] = [];
  for (const s of res.spots) if (s.tLand <= t && t - s.tLand < 3) ev.push({ r: (s.to / W) | 0, c: s.to % W, age: t - s.tLand, kind: 'spot' });
  for (const w of res.whirls) if (w.t <= t && t - w.t < 3) ev.push({ r: (w.cell / W) | 0, c: w.cell % W, age: t - w.t, kind: 'whirl' });
  for (const d of res.drops) if (d.t <= t && t - d.t < 4) ev.push({ r: d.r0, c: d.c0, r1: d.r1, c1: d.c1, age: t - d.t, kind: d.kind === 1 ? 'retardant' : 'water' });
  for (const b of clusterBreaches(res.breaches.filter((x) => x.t <= t))) if (t - b.t < 6) ev.push({ r: (b.cell / W) | 0, c: b.cell % W, age: t - b.t, kind: 'breach' });
  const wx = wxAt(t);
  if (wx && wx.collapseUntil > t) {
    const start = wx.collapseUntil - FIREWX.COLLAPSE_MAX; // approximate; ring loops while active
    ev.push({ r: wx.collapseR, c: wx.collapseC, age: (t - Math.max(start, wx.t - FIREWX.COLLAPSE_MIN)) % 15, kind: 'collapse' });
  }
  return ev;
}

// ---------- Readouts ----------
const el = (id: string) => document.getElementById(id)!;
const windArrow = el('wind-arrow');
const windText = el('wind-text');
const clock = el('clock');
const conditions = el('conditions');
const condSummary = el('cond-summary');
const firetech = el('firetech');
const fireSummary = el('fire-summary');
const zonesSummary = el('zones-summary');
// Only touch the DOM when content changes (keeps the side panel smooth to scroll)
const htmlCache = new WeakMap<HTMLElement, string>();
function smooth(node: HTMLElement): { innerHTML: string } {
  return {
    set innerHTML(html: string) {
      if (htmlCache.get(node) === html) return;
      htmlCache.set(node, html);
      node.innerHTML = html;
    },
    get innerHTML() {
      return node.innerHTML;
    },
  };
}
const responseEl = el('response');
const responseSummary = el('response-summary');
let response: ResponseState | null = null;
function breachText(b: { cell: number; t: number; kind: string }): string {
  const ll = cellToLatLng((b.cell / W) | 0, b.cell % W);
  let best = '';
  let bd = Infinity;
  for (const z of ZONES) {
    const d = Math.hypot((z.lat - ll.lat) * 111, (z.lng - ll.lng) * 92);
    if (d < bd) {
      bd = d;
      best = z.name;
    }
  }
  const when = new Date(simStartWall.getTime() + b.t * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${b.kind === 'spot' ? 'embers jumped it' : 'overran it'} ${bd < 4 ? 'near' : `${bd.toFixed(0)} km from`} ${best}, ${when}`;
}
let lastResponseAt = 0;
function airText(r: ResponseState): string {
  if (!sim.airAttack) return 'air attack off';
  if (r.airGrounded) return `grounded (gusts ${r.gustMph.toFixed(0)} mph)`;
  if (r.airNight) return `${r.aircraftFlying} helicopters (night: no air tankers)`;
  return `${r.aircraftFlying} flying`;
}
function dropText(r: ResponseState): string {
  if (!sim.airAttack) return 'off';
  if (!r.drops) return 'none yet';
  const ago = r.lastDropT !== null ? ` · last ${fmtDuration(Math.max(0, sim.simTime - r.lastDropT))} ago` : '';
  return `${r.drops} (${r.retardantDrops} retardant, ${r.drops - r.retardantDrops} water)${ago}`;
}

function updateResponse(now: number): void {
  if (!sim.result || !sim.ignitions.length) {
    response = null;
    overlay.contained = null;
    responseSummary.textContent = '';
    smooth(responseEl).innerHTML = '';
    return;
  }
  if (now - lastResponseAt < 1500) return;
  lastResponseAt = now;
  const tIgn = Math.min(...sim.ignitions.map((x) => x.t));
  response = computeResponse(sim.result, grid.fuel, grid.blocked, sim.simTime, tIgn, sim.weather, sim.clockStartMin);
  overlay.contained = response.containmentPct > 0 ? response.contained : null;
  const r = response;
  responseSummary.innerHTML =
    `<span${r.containmentPct < 10 ? ' class="hot"' : ''}>${r.containmentPct.toFixed(0)}% contained</span> · ${r.engines} engines · ` +
    (r.airGrounded ? '<span class="hot">aircraft grounded</span>' : `${r.aircraftFlying} aircraft · ${r.drops} drops`);
  smooth(responseEl).innerHTML = dl([
    ['Containment', `${r.containmentPct.toFixed(0)}%`, r.containmentPct < 10],
    ['Control line', `${r.lineKm.toFixed(1)} km built · ${r.perimeterKm.toFixed(1)} km perimeter`],
    ['Edge held by line', `${r.holdableKm.toFixed(1)} km`],
    ['Escapes past the line', r.breaches ? `${r.breaches} · last: ${breachText(r.lastBreach!)}` : 'none yet', r.breaches > 0],
    ['Engines', `${r.engines}`],
    ['Hand crews · dozers', `${r.crews} · ${r.dozers}`],
    ['Aircraft', airText(r), r.airGrounded],
    ['Air drops', dropText(r)],
  ]);
}
// ⚙ Simulation: show/hide the simulation controls row
const simbar = el('simbar');
const simBtn = el('btn-simbar');
const setSimbar = (open: boolean) => {
  simbar.hidden = !open;
  simBtn.classList.toggle('on', open);
  simBtn.textContent = open ? '⚙ Simulation ▴' : '⚙ Simulation ▾';
  map.invalidateSize();
  try {
    localStorage.setItem('simbar', open ? 'open' : 'closed');
  } catch {
    /* ignore */
  }
};
simBtn.onclick = () => setSimbar(simbar.hidden);
try {
  setSimbar(localStorage.getItem('simbar') === 'open');
} catch {
  setSimbar(false);
}
// remember which folds are open (per-viewer convenience only)
for (const id of ['fold-conditions', 'fold-firetech', 'fold-fire', 'fold-zones', 'fold-response']) {
  const d = document.getElementById(id) as HTMLDetailsElement;
  const demoOpen = DEMO_MODE && (id === 'fold-zones' || id === 'fold-fire');
  try {
    const saved = localStorage.getItem(id);
    d.open = saved ? saved === 'open' : demoOpen;
  } catch {
    d.open = demoOpen;
  }
  d.addEventListener('toggle', () => {
    try {
      localStorage.setItem(id, d.open ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  });
}
const firestats = el('firestats');
const zonesEl = el('zones');
const hint = el('hint');
const cellHa = (CELL_M * CELL_M) / 10000;

function dl(rows: [string, string, boolean?][]): string {
  return rows.map(([k, v, hot]) => `<dt>${k}</dt><dd${hot ? ' class="hot"' : ''}>${v}</dd>`).join('');
}

let lastPanel = 0;
let lastCompareAt = 0;
function updatePanel(stats: ReturnType<FireOverlay['renderFire']>): void {
  const now = performance.now();
  if (now - lastPanel < 200) return;
  lastPanel = now;
  const t = sim.simTime;
  const wall = new Date(simStartWall.getTime() + t * 60000);
  const wallTxt = scenario
    ? wall.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : wall.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  clock.textContent = `T+${fmtDuration(t)} · ${wallTxt}`;
  if (sim.weather.length === 0) return;
  const wp = weatherAt(sim.weather, t);
  const env = envAt(sim.weather, t, sim.dryness);
  const wx = wxAt(t);
  const liveU = wx ? wx.U10 : wp.speedMps;
  const liveDir = wx ? wx.fromDeg : wp.fromDeg;
  windArrow.style.transform = `rotate(${liveDir + 180}deg)`;
  windText.textContent = `${mpsToMph(liveU).toFixed(0)} mph from ${degToCompass(liveDir)}${wx && sim.fireWx ? ' (gusting)' : ''}`;
  const crown = crownFactor(env.U, env.moisture);
  const crownTxt = crown > 1.5 ? 'crown fire likely' : crown > 1.1 ? 'crown fire possible' : '';
  condSummary.innerHTML =
    `${mpsToMph(liveU).toFixed(0)} mph ${degToCompass(liveDir)} · RH ${wp.rh.toFixed(0)}% · ` +
    `<span${env.moisture < 6 ? ' class="hot"' : ''}>fuel ${env.moisture.toFixed(1)}%</span>` +
    (crownTxt ? ` · <span class="hot">${crownTxt}</span>` : '');
  smooth(conditions).innerHTML = dl([
    ['Wind (forecast)', `${mpsToMph(wp.speedMps).toFixed(0)} mph ${degToCompass(wp.fromDeg)}`],
    ['Wind (at fire)', `${mpsToMph(liveU).toFixed(0)} mph ${degToCompass(liveDir)}`],
    ['Gusts', `${mpsToMph(wp.gustMps).toFixed(0)} mph`],
    ['Temp / RH', `${wp.tempC.toFixed(0)}°C / ${wp.rh.toFixed(0)}%`],
    ['Rain last 24h', `${wp.rain24.toFixed(1)} mm`],
    ['Fine fuel moisture', `${env.moisture.toFixed(1)}%`, env.moisture < 6],
    ['Dryness factor', `×${env.dryF.toFixed(2)}`, env.dryF > 1.3],
    ['Grass head rate', `${(env.head[1] * 0.06).toFixed(1)} km/h`],
    ['Crown fire', crown > 1.5 ? 'likely' : crown > 1.1 ? 'possible' : 'unlikely', crown > 1.5],
    ['Ellipse L:W', env.lw.toFixed(1)],
  ]);
  const behaviour = !wx || !sim.fireWx ? '–' : wx.phi > 0.6 ? 'PLUME-DOMINATED' : wx.phi > 0.15 ? 'transitional' : 'wind-driven';
  const collapse = !!wx && sim.fireWx && wx.collapseUntil > t;
  const whirlsSoFar = sim.result ? sim.result.whirls.filter((w) => w.t <= t).length : 0;
  if (perimeterMask && sim.result && now - lastCompareAt > 1000) {
    lastCompare = compare(sim.result.arrival, t, perimeterMask);
    lastCompareAt = now;
  }
  const acres = Math.round(stats.burnedCells * cellHa * HA_TO_ACRES);
  const containPct = response ? (response.containmentPct >= 99.5 ? 100 : Math.floor(response.containmentPct)) : 0;
  smooth(fireSummary).innerHTML = sim.ignitions.length
    ? `<b>${acres.toLocaleString()} acres</b> · <span class="${containPct >= 100 ? 'ok' : containPct < 10 ? 'hot' : ''}">${containPct}% contained</span>` +
      (collapse ? ' · <span class="hot">column collapse</span>' : '')
    : 'no fire';
  smooth(firestats).innerHTML = dl([
    ['Acres burned', acres.toLocaleString()],
    ['Containment', containPct >= 100 ? '100% · fully contained' : `${containPct}%`, containPct < 10],
    ['Head spread', `${(stats.headRos * 0.06 * 0.621).toFixed(1)} mph`, stats.headRos > 30],
    ...(response
      ? ([
          ['Firefighters on scene', `${response.engines} engines · ${response.crews} crews · ${response.dozers} dozers`],
          ['Aircraft', airText(response), response.airGrounded],
          ['Retardant & water drops', dropText(response)],
          ['Escapes past the line', response.breaches ? `${response.breaches} · last: ${breachText(response.lastBreach!)}` : 'none yet', response.breaches > 0],
        ] as [string, string, boolean?][])
      : []),
    ...(lastCompare && scenario
      ? ([
          ['Real final perimeter', `${Math.round(lastCompare.realHa * HA_TO_ACRES).toLocaleString()} acres`],
          ['Overlap with real burn', `${lastCompare.overlapPct.toFixed(0)}%`],
        ] as [string, string][])
      : []),
  ]);
  smooth(firetech).innerHTML = dl([
    ['Head spread', `${stats.headRos.toFixed(0)} m/min`],
    ['Convective no. (Byram)', wx ? wx.nc.toFixed(1) : '–'],
    ['Intensity', wx ? `${(wx.intensity / 1000).toFixed(1)} MW/m` : '–', !!wx && wx.intensity > 10000],
    ['Indraft', wx ? `${mpsToMph(wx.indraft).toFixed(0)} mph` : '–'],
    ['Flame front', `${((stats.activeCells * CELL_M) / 1000).toFixed(1)} km`],
    ['Solver', computing ? 'computing…' : `${lastSolveMs.toFixed(0)} ms`],
  ]);
  hint.style.display = sim.ignitions.length ? 'none' : '';
  updateZones(t);
}

function zoneText(k: number, t: number): { short: string; long: string; level: 0 | 1 | 2 | 3 } {
  if (!sim.result) return { short: '', long: '–', level: 0 };
  const st = zoneStats(sim.result, [zCells[k]], t)[0];
  if (st.arrival <= t) return { short: `BURNING ${st.pctBurned.toFixed(0)}%`, long: `burning · ${st.pctBurned.toFixed(0)}% burned`, level: 3 };
  const eta = st.arrival - t;
  let range = '';
  let reach = '';
  if (ensemble) {
    const s = summarise(ensemble.res.arrivals[k], t);
    if (s.reached > 0) range = `${fmtDuration(Math.max(0, s.lo))}–${fmtDuration(Math.max(0, s.hi))}`;
    reach = `${Math.round(s.reached * 100)}% of runs`;
  }
  if (!isFinite(eta)) {
    return { short: reach && reach !== '0% of runs' ? `reached in ${reach}` : 'not in 12h', long: reach ? `not reached in base run · ${reach}` : 'not reached in 12h', level: reach && reach !== '0% of runs' ? 1 : 0 };
  }
  const level = eta < 60 ? 3 : eta < 180 ? 2 : 1;
  return { short: `ETA ${fmtDuration(eta)}${range ? ` (${range})` : ''}`, long: `${fmtDuration(eta)}${range ? ` · range ${range}` : ''}${reach ? ` · ${reach}` : ''}`, level };
}

const LEVEL_COLOR = ['#7fc4ff', '#f2c94c', '#ff9f1a', '#ff3b30'];
function updateZones(t: number): void {
  const rows: [string, string, boolean?][] = [];
  const sitZones = situation(false)?.zones ?? [];
  const tiers = new Map(assignTiers(sitZones).map((x) => [x.zone.id, x.tier]));
  let worst: { name: string; text: string; level: number } | null = null;
  ZONES.forEach((z, k) => {
    const zt = zoneText(k, t);
    if (zt.level > 0 && (!worst || zt.level > worst.level)) worst = { name: `${z.id} ${z.name}`, text: zt.short, level: zt.level };
    zoneLayers[k].setStyle({ color: LEVEL_COLOR[zt.level] });
    zoneLayers[k].setTooltipContent(`Zone ${z.id}: ${z.name}${zt.short ? `<br>${zt.short}` : ''}`);
    const sz = sitZones[k];
    const mto = sz ? minutesToOrder(sz) : null;
    const tier = tiers.get(z.id);
    const trig = tier === 'EVACUATION ORDER' ? ' · <b>ORDER</b>' : mto !== null && mto < 480 ? ` · order trigger in ${fmtDuration(mto)} (needs ${z.clearanceMin}m to clear)` : '';
    rows.push([`${z.id} · ${z.name}`, zt.long + trig, zt.level >= 2 || tier === 'EVACUATION ORDER']);
  });
  const status = ensembleRunning ? `running ${ENSEMBLE_N} what-if weather variants…` : ensemble ? `range = 10th–90th pct of ${ensemble.res.members} runs (wind ±20%, ±15°, dryness ±10%)` : '';
  smooth(zonesEl).innerHTML = dl(rows) + (status ? `<p class="muted">${status}</p>` : '');
  const w = worst as { name: string; text: string; level: number } | null;
  smooth(zonesSummary).innerHTML = !sim.ignitions.length
    ? ''
    : w
      ? `<span${w.level >= 2 ? ' class="hot"' : ''}>${w.name}: ${w.text}</span>`
      : 'no zone at risk in 12h';
}

// ---------- Warnings ----------
/** Compass direction and distance (km) from a zone centre to the nearest burned cell at time t. */
function nearestFire(lat: number, lng: number, t: number): { dir: string; km: number } | null {
  const res = sim.result;
  if (!res) return null;
  const p = latLngToRC(lat, lng);
  let best = Infinity;
  let br = 0;
  let bc = 0;
  const A = res.arrival;
  for (let i = 0; i < A.length; i++) {
    if (!(A[i] <= t)) continue;
    const r = (i / W) | 0;
    const c = i - r * W;
    const d = (r - p.r) ** 2 + (c - p.c) ** 2;
    if (d < best) {
      best = d;
      br = r;
      bc = c;
    }
  }
  if (!isFinite(best)) return null;
  const bearing = (Math.atan2(bc - p.c, -(br - p.r)) * 180) / Math.PI;
  return { dir: degToCompass((bearing + 360) % 360), km: (Math.sqrt(best) * CELL_M) / 1000 };
}

function situation(withGeo: boolean) {
  const res = sim.result;
  if (!res || !sim.ignitions.length) return null;
  const t = sim.simTime;
  const stats = zoneStats(res, zCells, t);
  const zones: ZoneSituation[] = ZONES.map((z, k) => {
    const base = isFinite(stats[k].arrival) ? Math.max(0, stats[k].arrival - t) : null;
    let lo = base;
    let hi = base;
    let reached: number | null = null;
    if (ensemble) {
      const s = summarise(ensemble.res.arrivals[k], t);
      reached = Math.round(s.reached * 100);
      if (isFinite(s.lo)) lo = Math.max(0, base === null ? s.lo : Math.min(base, s.lo));
      if (isFinite(s.hi)) hi = Math.max(0, base === null ? s.hi : Math.max(base, s.hi));
    }
    const nf = withGeo ? nearestFire(z.lat, z.lng, t) : null;
    return {
      id: z.id,
      name: z.name,
      clearanceMin: z.clearanceMin,
      burningPct: stats[k].arrival <= t ? stats[k].pctBurned : 0,
      etaBase: base,
      etaEarliest: lo,
      etaLatest: hi,
      reachedPct: reached,
      fireDir: nf?.dir ?? null,
      fireKm: nf?.km ?? null,
    };
  });
  const wp = weatherAt(sim.weather, t);
  const wx = wxAt(t);
  const U = wx ? wx.U10 : wp.speedMps;
  const dir = wx ? wx.fromDeg : wp.fromDeg;
  const behaviour = !wx || !sim.fireWx ? 'wind-driven' : wx.phi > 0.6 ? 'plume-dominated (erratic)' : wx.phi > 0.15 ? 'transitional' : 'wind-driven';
  return {
    zones,
    ctx: { windMph: mpsToMph(U), windFrom: degToCompass(dir), behaviour, spotFires: res.spots.filter((s) => s.tLand <= t).length },
    simTime: t,
    wallTime: new Date(simStartWall.getTime() + t * 60000),
    // auto-alerts wait for fresh uncertainty runs so tiers use the earliest plausible arrival
    ready: !computing && !ensembleRunning && ensemble !== null,
  };
}

const warnings = new WarningsPanel(situation);
setInterval(() => warnings.tick(), 1000);

// ---------- Animation loop ----------
let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing && sim.ignitions.length) {
    sim.simTime += dt * speed;
    // extend the solved horizon before playback runs past it
    if (sim.result && !computing && sim.simTime > sim.result.horizon - 60) void recompute();
  }
  updateResponse(now);
  const stats = overlay.renderFire(sim.result, sim.simTime);
  overlay.events = collectEvents(sim.simTime);
  overlay.draw();
  if (sim.weather.length) {
    const wx = wxAt(sim.simTime);
    const wp = weatherAt(sim.weather, sim.simTime);
    const U = wx ? wx.U10 : wp.speedMps;
    const toward = (((wx ? wx.fromDeg : wp.fromDeg) + 180) * Math.PI) / 180;
    const whirls = (sim.result?.whirls ?? [])
      .filter((w) => w.t <= sim.simTime && sim.simTime - w.t < 4)
      .map((w) => ({ r: (w.cell / W) | 0, c: w.cell % W, age: sim.simTime - w.t }));
    windNow = { U, tE: Math.sin(toward), tN: Math.cos(toward), wx: sim.result && sim.ignitions.length ? wx : null, whirls };
    const fromDeg = wx ? wx.fromDeg : wp.fromDeg;
    windLayer.setBadge(fromDeg, degToCompass(fromDeg), mpsToMph(U), mpsToMph(wp.gustMps));
  }
  windLayer.frame();
  updatePanel(stats);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// URL params for scripted demos/tests: ?scenario=eaton&t=90&speed=5
async function boot(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const qw = q.get('wx');
  const wx: WxChoice = qw === 'redflag' || qw === 'hotstill' || qw === 'santaana' ? qw : 'live';
  (document.getElementById('wx-source') as HTMLSelectElement).value = wx;
  await loadWeather(wx);
  const sp = Number(q.get('speed'));
  if (PLAYBACK.SPEEDS.includes(sp)) {
    speed = sp;
    controls.setSpeed(sp);
  }
  const ig = q.get('ignite');
  if (ig) {
    const [lat, lng] = ig.split(',').map(Number);
    const hr = Number(q.get('hour')); // start time of day (fire's local time), e.g. &hour=10
    if (q.has('hour') && hr >= 0 && hr < 24) {
      const d = new Date();
      d.setHours(hr, 0, 0, 0);
      setStartWall(d, true);
    }
    if (q.get('air') === '0') {
      sim.airAttack = false;
      airToggle.checked = false;
    }
    if (isFinite(lat) && isFinite(lng) && sim.ignite([{ lat, lng }]) > 0) {
      await recompute();
      const t = Number(q.get('t'));
      if (t > 0) sim.simTime = t;
      repaint();
      playing = q.get('play') !== '0';
      controls.setPlaying(playing);
    }
  }
}
void boot();

// ---------- Scenarios: Palisades / Eaton replay (real Jan 2025 weather + official perimeter) ----------
let scenario: ScenarioKey | null = null;
let perimeterLayer: L.GeoJSON | null = null;
let perimeterMask: Uint8Array | null = null;
let lastCompare: Comparison | null = null;

async function showPerimeter(key: ScenarioKey): Promise<void> {
  perimeterLayer?.remove();
  perimeterLayer = null;
  perimeterMask = null;
  try {
    const geo = (await (await fetch(`/perimeters/${key}.geojson`)).json()) as PerimeterGeo;
    perimeterLayer = L.geoJSON(geo as never, {
      style: { color: '#ffffff', weight: 2, dashArray: '6 6', fill: false, opacity: 0.9 },
      interactive: false,
    })
      .bindTooltip(`Official final perimeter · ${SCENARIOS[key].name} (${SCENARIOS[key].realAcres.toLocaleString()} acres)`, { sticky: true })
      .addTo(map);
    perimeterMask = rasterizePerimeter(geo);
  } catch (err) {
    console.warn('perimeter failed', err);
  }
}

async function startScenario(key: ScenarioKey): Promise<void> {
  const sc = SCENARIOS[key];
  scenario = key;
  sim.reset();
  warnings.reset();
  ensemble = null;
  ensembleSeq++;
  (document.getElementById('wx-source') as HTMLSelectElement).value = 'historical';
  const seq = ++wxSeq;
  const hist = await historicalSchedule(key, sc.start, sc.windDirOffset);
  if (seq !== wxSeq) return;
  schedule = hist;
  sim.setWindSchedule(hist.points);
  setStartWall(hist.startLocal, true);
  document.getElementById('wx-note')!.textContent = hist.note;
  void showPerimeter(key);
  map.setView([sc.lat, sc.lng], sc.zoom);
  if (sim.ignite([{ lat: sc.lat, lng: sc.lng }]) === 0) return;
  await recompute();
  playing = true;
  controls.setPlaying(true);
}
document.getElementById('btn-palisades')!.onclick = () => void startScenario('palisades');
document.getElementById('btn-eaton')!.onclick = () => void startScenario('eaton');
const sq = new URLSearchParams(location.search).get('scenario');
if (sq === 'palisades' || sq === 'eaton') void startScenario(sq);
document.getElementById('data-note')!.textContent = dataNote;
