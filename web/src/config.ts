// All location, grid, timing and physics constants live here.
// Physics values are demo-tuned, not calibrated fire science.

// ---------- Location & grid ----------
// The fire model runs on a 60 m grid window (1000 x 480 cells = 60 x 28.8 km) that moves to wherever a
// fire starts in the megaregion. Default window: Santa Monica Mountains (Palisades) to San Gabriel foothills (Eaton).
export const CENTER = { lat: 34.13, lng: -118.34 };
export const W = 1000;
export const H = 480;
export const CELL_M = 60;
export const ENSEMBLE_N = 8; // uncertainty runs per recompute
export const DEMO_MODE = true; // hide secondary controls/panels for a clean demo (set false to show everything)
export const HA_TO_ACRES = 2.47105;
export const SEED = 1337;
export const HORIZON_MIN = 10080; // solver looks this far ahead of "now" (7 days: long enough to reach full containment)

// ---------- Fuels ----------
export const NONE = 0;
export const GRASS = 1;
export const SHRUB = 2;
export const FOREST = 3;
export const URBAN = 4; // wildland-urban interface: homes among vegetation (burns house-to-house)
export const CITY = 5; // dense city: mostly pavement/roofs, hard to ignite

export interface FuelParams {
  name: string;
  r0: number; // no-wind spread rate, m/min, at reference moisture
  windA: number; // wind sensitivity: windF = 1 + windA * U^B_WIND
  residence: number; // minutes a cell keeps burning
  spot: number; // ember source strength 0..1
  crown: boolean; // can transition to crown fire in strong, dry wind
  structure?: boolean; // spreads structure-to-structure (embers + radiant heat), not as vegetation
  emp: number; // empirical head rate as a fraction of 10 m wind speed (Cruz & Alexander rules)
  recept: number; // chance a landing ember ignites this fuel (dry conditions)
  load: number; // fuel consumed in the flaming front, kg/m2 (for Byram intensity)
  color: string;
}

export const FUELS: FuelParams[] = [
  // emp: grass ~20% of wind speed (cured grass, 2022), forest/shrub ~10% (Cruz & Alexander 2019).
  // urban: vegetation path is slow; towns burn mainly via embers + house-to-house (below).
  { name: 'none', load: 0, r0: 0, windA: 0, residence: 0, spot: 0, crown: false, emp: 0, recept: 0, color: '#7fb2d9' },
  { name: 'grass', load: 0.4, r0: 2.0, windA: 1.0, residence: 5, spot: 0, crown: false, emp: 0.2, recept: 0.9, color: '#cdbb6a' },
  { name: 'shrub', load: 1.2, r0: 1.2, windA: 1.1, residence: 20, spot: 0.4, crown: false, emp: 0.1, recept: 0.6, color: '#8f9d4c' },
  { name: 'forest', load: 2.0, r0: 0.6, windA: 1.3, residence: 60, spot: 1.0, crown: true, emp: 0.1, recept: 0.5, color: '#3d6534' },
  { name: 'urban', load: 4.0, r0: 0.4, windA: 1.0, residence: 180, spot: 0.8, crown: false, structure: true, emp: 0, recept: 0.55, color: '#b07a5a' },
  { name: 'city', load: 2.0, r0: 0.05, windA: 0.3, residence: 120, spot: 0.2, crown: false, structure: true, emp: 0, recept: 0.06, color: '#8a8a8a' },
];
export const ROAD_COLOR = '#bdbdbd';

// ---------- Physics ----------
export const PHYS = {
  // Wind: Rhead = r0 * (1 + windA * Ueff^B_WIND) * ...
  B_WIND: 1.3,
  // Fires respond to gusts: Ueff = U + GUST_WEIGHT * (gust - U)
  GUST_WEIGHT: 0.3,

  // Fine dead fuel moisture (%) from Open-Meteo temp + RH (Simard EMC),
  // plus a bump for rain in the previous 24 h.
  RAIN_MOIST_PER_MM: 2,
  RAIN_MOIST_MAX: 15,
  // dryness factor = exp(-MOIST_K * (moisture - MOIST_REF)), clamped
  MOIST_REF: 8,
  MOIST_K: 0.12,
  DRY_MIN: 0.08,
  DRY_MAX: 1.8,

  // Crown fire: forest spread multiplies up once wind passes a threshold
  // and fuels are dry. Smooth ramp between CROWN_U0 and CROWN_U1 (m/s).
  CROWN_U0: 7,
  CROWN_U1: 11,
  CROWN_MULT: 2.5,
  CROWN_MOIST_FULL: 8, // full crowning at or below this moisture %
  CROWN_MOIST_NONE: 14, // no crowning at or above this

  // Empirical calibration: in strong wind, head rate blends toward emp * U10.
  // Blend weight ramps from EMP_U0 to EMP_U1 m/s (the rules were fit to windy, dry fires).
  EMP_U0: 4,
  EMP_U1: 9,
  EMP_DRY_REF: 1.43, // dryness factor of the rules' typical fuel moisture (~5%)
  EMP_DRY_MAX: 1.15, // don't let extreme dryness push past the rules by much

  // Ellipse length-to-width: Alexander (1985), U in km/h, saturates ~9.7
  LW_MAX: 6.5,

  // Slope: spread roughly doubles per 10 deg uphill
  SLOPE_K: 0.0693,
  SLOPE_MAX_DEG: 40,

  // Acceleration: new fires start slow
  TAU_ACCEL: 20,
  GROWTH_FLOOR: 0.15,

  // Spotting
  SPOT_U_MIN: 7, // m/s
  SPOT_PER_HA_PER_MS: 0.006, // expected spots per burned hectare per m/s above SPOT_U_MIN
  SPOT_MEDIAN_PER_MS: 30, // median ember distance = this * U meters
  SPOT_SIGMA: 0.9, // lognormal (Sardoy-type) heavy tail: 15 m/s -> median 450 m, 95th pct ~2 km
  SPOT_SPREAD_DEG: 15,
  SPOT_DELAY_MIN: 2,
  SPOT_DELAY_MAX: 5,
  // House-to-house: a burning structure throws short-range embers/radiant heat
  // at neighbours regardless of wind threshold.
  HOUSE_SPOT_P: 0.22,
  HOUSE_SPOT_MEDIAN_M: 45,
  HOUSE_SPOT_SIGMA: 0.5,
  HOUSE_SPOT_SPREAD_DEG: 75,
  HOUSE_SPOT_DELAY_MIN: 4,
  HOUSE_SPOT_DELAY_MAX: 15,

  // Structure-to-structure spread (WUI conflagration): head rate = (U0 + UK * wind) * dryness, m/min.
  // Much slower than vegetation, driven by embers and radiant heat between homes; houses burn for hours.
  // ~0.35 km/h at 15 m/s wind: consistent with neighbourhoods burning block by block overnight.
  STRUCT_R0: 0.5,
  STRUCT_UK: 0.3,
  STRUCT_DRY_MAX: 1.3,
  STRUCT_CITY_K: 0.15, // dense city: same mechanism but far fewer combustible gaps
  // Vegetation continuity: structure spread + ember ignition scale with the share of vegetation within
  // ~650 m. Leafy wildland-edge neighbourhoods burn readily; dense low-vegetation city resists.
  STRUCT_VEG_LO: 0.08,
  STRUCT_VEG_HI: 0.4,
  STRUCT_MIN_MULT: 0.12,
  // Urban greenery (street trees, parks, yards) is irrigated and patchy: vegetation cells surrounded by
  // built-up area spread far slower than wildland. Factor ramps down as the built-up share rises.
  URBAN_VEG_LO: 0.35,
  URBAN_VEG_HI: 0.7,
  URBAN_VEG_MULT: 0.06,
  // Suburban blocks within this distance of wildland (vision C/F/G) are interface WUI: yards stay flammable
  INTERFACE_M: 1500,
  // Urban conflagration is poorly constrained (few precedents): user setting + varied across ensemble
  URBAN_SPREAD: { low: 0.5, medium: 1, high: 1.7 } as Record<string, number>,

  // Roads stop slow flank/backing fire but a fast head fire jumps them
  ROAD_BREACH_ROS: 12, // m/min

  // Santa Ana-type wind exposure: full strength in foothills/canyons (high local relief),
  // weaker over the flat basin. Exposure = MIN + (1-MIN) * smoothstep(R0, R1, relief within ~1.8 km)
  WIND_EXPOSURE_MIN: 0.6,
  WIND_RELIEF_R0: 60,
  WIND_RELIEF_R1: 350,

  // Suppression: crews/equipment can directly attack fire edges below ~1,700 kW/m (about 8 ft flames,
  // the usual fireline-intensity limit for direct attack). After crews arrive, those edges spread slower.
  // Wind-driven head fires and structure fires stay above the limit, as in real conflagrations.
  SUPPRESS_ON: true,
  SUPPRESS_START_MIN: 60,
  SUPPRESS_I_MAX: 1700, // kW/m (crews alone, dangerous wind)
  SUPPRESS_I_MAX_AIR: 3500, // kW/m when wind allows aircraft (retardant + crews hold hotter edges)
  SUPPRESS_AIR_WIND_MS: 10,
  SUPPRESS_K: 0.3,
  // Low-intensity creep (< ~500 kW/m, flames under ~4 ft) gets put out by hand crews in calm wind
  EXTINGUISH_I_MAX: 500,
  EXTINGUISH_K: 0.05,
  // Structure defence: engines + hydrants hold built-up areas (low vegetation continuity) once on scene
  STRUCT_DEFEND_BELOW: 0.6, // structure susceptibility below which defence is effective
  STRUCT_DEFEND_K: 0.5,

  ROS_MIN: 0.01,
};

// ---------- Fire-generated weather (parameterized, not a coupled atmosphere model) ----------
export const FIREWX = {
  ENABLED: true,
  // Gusts: OU noise on wind speed (log-multiplier) and direction
  GUST_SIGMA_SPEED: 0.18,
  GUST_SIGMA_DIR_DEG: 12,
  GUST_TAU_MIN: 12,

  STATE_DT: 2, // minutes between fire-state updates
  WINDOW_MIN: 6, // recent-ignition window used for intensity / heat centre
  HEAT_CONTENT: 18000, // kJ/kg (Byram)

  // Byram convective number Nc: <2 wind-driven, 2-10 transitional, >10 plume-dominated
  NC_LO: 2,
  NC_HI: 10,
  PLUME_MIN_HA: 10, // plume needs a fire of some size
  PLUME_FULL_HA: 60,
  // Plume-dominated: ambient wind steers less. Head speed drops a little, shape gets rounder.
  PLUME_HEAD_DAMP: 0.12,
  PLUME_SHAPE_DAMP: 0, // no rounding: calm + plume should not speed up flanks
  PLUME_SPOT_P: 0.0012, // per igniting cell, extra lofting from the convection column
  PLUME_SPOT_DIST_K: 1.5, // median distance x (1 + K * phi)
  PLUME_SPOT_SPREAD_DEG: 60,

  // Column collapse: plume falls back, outflow pushes fire outward
  // Collapse needs a strong column: plume-dominated AND an intense front (calm + weak fire = fire lies down)
  COLLAPSE_PHI: 0.6,
  COLLAPSE_I_MIN: 12000, // kW/m
  COLLAPSE_P_PER_TICK: 0.015,
  COLLAPSE_MIN: 8,
  COLLAPSE_MAX: 15,
  COLLAPSE_SPEED_MIN: 3,
  COLLAPSE_SPEED_MAX: 6,
  COLLAPSE_RADIUS_M: 1000,

  // Indraft: air pulled into the fire from the sides (cross-wind component only)
  INDRAFT_MAX: 3, // m/s
  INDRAFT_P0_GW: 5,

  // Fire whirls on high-intensity flanks in strong wind
  WHIRL_U_MIN: 7,
  WHIRL_I_MIN: 12000, // kW/m
  WHIRL_FLANK_COS: 0.35,
  WHIRL_P: 0.0006,
  WHIRL_EMBERS: 4,
  WHIRL_MEDIAN_M: 90,
};

// ---------- Weather ----------
export interface WeatherPreset {
  speedMps: number;
  gustMps: number;
  fromDeg: number;
  tempC: number;
  rh: number;
  rain24: number;
}
export const WEATHER = {
  TIMEOUT_MS: 6000,
  // Used when Open-Meteo fails
  FALLBACK: { speedMps: 8, gustMps: 11, fromDeg: 225, tempC: 24, rh: 30, rain24: 0 } as WeatherPreset,
  // Demo preset: dry downslope wind event from the NE
  RED_FLAG: { speedMps: 15, gustMps: 22, fromDeg: 45, tempC: 18, rh: 12, rain24: 0 } as WeatherPreset,
  // Santa Ana, Jan 7 2025-style: strong, gusty NE wind and very dry air
  SANTA_ANA: { speedMps: 18, gustMps: 31, fromDeg: 40, tempC: 18, rh: 9, rain24: 0 } as WeatherPreset,
  // Demo preset: hot, dry, light wind -> fire tends to become plume-dominated
  HOT_STILL: { speedMps: 4, gustMps: 6, fromDeg: 225, tempC: 36, rh: 9, rain24: 0 } as WeatherPreset,
};

// ---------- Rendering & playback ----------
export const RENDER = {
  TERRAIN_OPACITY: 0.35,
  HIDE_CITY_TINT: true, // let the satellite show through dense city
  FLAME_MIN: 3, // minutes a cell shows as flame front
  SCAR_FADE_MIN: 120,
  ROS_HOT: 80, // m/min that maps to yellow-white
};
export const PLAYBACK = { SPEEDS: [1, 2, 5, 10, 20], DEFAULT_SPEED: 5 }; // sim-minutes per real second

// Zones: hex zones covering all land in the Southern California megaregion live in zones.ts
// (generated by tools/build_zones.py). Not imported here so the solver worker stays small.

// Scenario starts (approximate origins; wind is a Jan-2025-style Santa Ana from the NE)
// start: reported ignition time (local, approximate). weather: hourly Open-Meteo historical
// forecast for Jan 7-10 2025 at the origin. perimeter: official final perimeter (NIFC WFIGS).
// windDirOffset: terrain-steering correction (deg clockwise) FITTED to the real burn: the ~3 km
// forecast grid shows NNE wind, but canyon-channelled Santa Anas drove both fires more westward.
// Fit: best 24 h overlap with the official perimeter (Palisades 18% -> 45%, Eaton 19% -> 25%).
export const SCENARIOS = {
  palisades: { name: 'Palisades', lat: 34.07, lng: -118.542, zoom: 13, start: '2025-01-07T10:30', realAcres: 23448, windDirOffset: 40 },
  eaton: { name: 'Eaton', lat: 34.196, lng: -118.098, zoom: 13, start: '2025-01-07T18:18', realAcres: 14021, windDirOffset: 15 },
};
export type ScenarioKey = keyof typeof SCENARIOS;
