// Display helpers: mph, compass directions, durations.
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const mpsToMph = (x: number) => x * 2.23694;
export const mphToMps = (x: number) => x / 2.23694;

export function degToCompass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const NAMES: Record<string, string> = {
  north: 'N', south: 'S', east: 'E', west: 'W',
  northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW',
};

/** Accepts "NE", "northeast", "north-east", "SSW", or a number string. Returns degrees or null. */
export function compassToDeg(s: string | number): number | null {
  if (typeof s === 'number') return ((s % 360) + 360) % 360;
  const t = s.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t) % 360;
  const code = (NAMES[t] ?? t).toUpperCase();
  const k = COMPASS.indexOf(code);
  return k < 0 ? null : k * 22.5;
}

export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
