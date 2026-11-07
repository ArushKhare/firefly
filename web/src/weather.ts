// Open-Meteo forecast -> hourly WeatherPoint schedule (sim t = 0 is "now").
import { WEATHER, type WeatherPreset } from './config.ts';
import type { WeatherPoint } from './sim/ros.ts';

export type WeatherSource = 'live' | 'redflag' | 'hotstill' | 'santaana' | 'historical' | 'fallback';

export interface WeatherSchedule {
  points: WeatherPoint[];
  source: WeatherSource;
  startLocal: Date; // wall-clock time at sim t = 0 (as local time of the fire area)
  note: string;
}

interface OpenMeteoResp {
  utc_offset_seconds: number;
  hourly: {
    time: string[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
    temperature_2m: (number | null)[];
    relative_humidity_2m: (number | null)[];
    precipitation: (number | null)[];
  };
}

let cache: { key: string; data: OpenMeteoResp } | null = null;

function constantSchedule(p: WeatherPreset, source: WeatherSource, note: string): WeatherSchedule {
  const pt = { atMinute: 0, ...p };
  return { points: [pt, { ...pt, atMinute: 48 * 60 }], source, startLocal: new Date(), note };
}

export function presetSchedule(kind: 'redflag' | 'hotstill' | 'santaana' | 'fallback'): WeatherSchedule {
  if (kind === 'santaana') return constantSchedule(WEATHER.SANTA_ANA, 'santaana', 'Santa Ana preset (Jan 2025-style)');
  if (kind === 'redflag') return constantSchedule(WEATHER.RED_FLAG, 'redflag', 'Red-flag preset');
  if (kind === 'hotstill') return constantSchedule(WEATHER.HOT_STILL, 'hotstill', 'Hot & still preset');
  return constantSchedule(WEATHER.FALLBACK, 'fallback', 'Open-Meteo unavailable, using fallback');
}

export async function fetchLiveWeather(lat: number, lng: number): Promise<WeatherSchedule> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${new Date().toISOString().slice(0, 13)}`;
  try {
    let data = cache?.key === key ? cache.data : null;
    if (!data) {
      try {
        const s = sessionStorage.getItem('om:' + key);
        if (s) data = JSON.parse(s);
      } catch {
        /* storage unavailable */
      }
    }
    if (!data) {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m,precipitation` +
        `&wind_speed_unit=ms&timezone=auto&past_days=1&forecast_days=2`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), WEATHER.TIMEOUT_MS);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as OpenMeteoResp;
      try {
        sessionStorage.setItem('om:' + key, JSON.stringify(data));
      } catch {
        /* ignore */
      }
    }
    cache = { key, data };
    return toSchedule(data);
  } catch (err) {
    console.warn('Open-Meteo failed, using fallback', err);
    return presetSchedule('fallback');
  }
}

function toSchedule(d: OpenMeteoResp): WeatherSchedule {
  const h = d.hourly;
  // Times are local to the fire area; compare as if UTC with the offset applied.
  const nowLocalMs = Date.now() + d.utc_offset_seconds * 1000;
  const ms = h.time.map((t) => Date.parse(t + ':00Z'));
  let idx = 0;
  for (let k = 0; k < ms.length; k++) if (ms[k] <= nowLocalMs) idx = k;
  const minutesIntoHour = (nowLocalMs - ms[idx]) / 60000;

  const num = (a: (number | null)[], k: number, dflt: number) => {
    const v = a[k];
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  };
  const points: WeatherPoint[] = [];
  for (let k = idx; k < h.time.length; k++) {
    let rain24 = 0;
    for (let q = Math.max(0, k - 24); q < k; q++) rain24 += num(h.precipitation, q, 0);
    const speed = num(h.wind_speed_10m, k, WEATHER.FALLBACK.speedMps);
    points.push({
      atMinute: (k - idx) * 60 - minutesIntoHour,
      speedMps: speed,
      gustMps: Math.max(speed, num(h.wind_gusts_10m, k, speed * 1.4)),
      fromDeg: num(h.wind_direction_10m, k, WEATHER.FALLBACK.fromDeg),
      tempC: num(h.temperature_2m, k, WEATHER.FALLBACK.tempC),
      rh: num(h.relative_humidity_2m, k, WEATHER.FALLBACK.rh),
      rain24,
    });
  }
  if (points.length === 0) return presetSchedule('fallback');
  // sim t=0 is exactly now: clamp the first point
  points[0] = { ...points[0], atMinute: Math.min(0, points[0].atMinute) };
  return { points, source: 'live', startLocal: new Date(), note: 'Open-Meteo hourly forecast' };
}

/**
 * Replay real hourly weather (Open-Meteo historical forecast, saved in /public/weather) from a
 * scenario's ignition time. Sim t = 0 is the ignition; startLocal is that wall-clock time.
 */
export async function historicalSchedule(key: string, startIso: string, windDirOffset = 0): Promise<WeatherSchedule> {
  try {
    const r = await fetch(`/weather/${key}.json`, { signal: AbortSignal.timeout(WEATHER.TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as OpenMeteoResp;
    const h = d.hourly;
    const t0 = Date.parse(startIso + ':00Z'); // compare as naive local times
    const points: WeatherPoint[] = [];
    for (let k = 0; k < h.time.length; k++) {
      const tk = Date.parse(h.time[k] + ':00Z');
      let rain24 = 0;
      for (let q = Math.max(0, k - 24); q < k; q++) rain24 += h.precipitation?.[q] ?? 0;
      const speed = h.wind_speed_10m[k] ?? WEATHER.FALLBACK.speedMps;
      points.push({
        atMinute: (tk - t0) / 60000,
        speedMps: speed,
        gustMps: Math.max(speed, h.wind_gusts_10m[k] ?? speed),
        fromDeg: ((h.wind_direction_10m[k] ?? WEATHER.FALLBACK.fromDeg) + windDirOffset + 360) % 360,
        tempC: h.temperature_2m[k] ?? WEATHER.FALLBACK.tempC,
        rh: h.relative_humidity_2m[k] ?? WEATHER.FALLBACK.rh,
        rain24,
      });
    }
    const [y, mo, da] = startIso.slice(0, 10).split('-').map(Number);
    const [hh, mi] = startIso.slice(11, 16).split(':').map(Number);
    return { points, source: 'historical', startLocal: new Date(y, mo - 1, da, hh, mi), note: `Real hourly weather, Jan 7–10 2025 (Open-Meteo historical)${windDirOffset ? ` · wind direction +${windDirOffset}° terrain-steering correction, fitted to the real burn` : ''}` };
  } catch (err) {
    console.warn('historical weather failed, using Santa Ana preset', err);
    return presetSchedule('santaana');
  }
}
