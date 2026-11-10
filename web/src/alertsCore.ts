// Alert safety core, shared by server and browser (pure, no DOM, no network).
// The browser may only send STRUCTURED facts (zone id, tier, minutes, wind numbers). The server
// validates them against known values, builds the prompt itself, and fact-checks the model's output
// before anything is shown, spoken or sent. Free text from the browser never reaches the model.
import { zoneById } from './zones.ts';
import { fmtDuration } from './units.ts';

export const TIERS = ['EVACUATION ORDER', 'EVACUATION WARNING', 'MONITOR'] as const;
export type AlertTier = (typeof TIERS)[number];
const TIER_ES: Record<AlertTier, string> = {
  'EVACUATION ORDER': 'ORDEN DE EVACUACIÓN',
  'EVACUATION WARNING': 'ADVERTENCIA DE EVACUACIÓN',
  MONITOR: 'MANTÉNGASE ALERTA',
};
export const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const BEHAVIOURS = ['wind-driven', 'transitional', 'plume-dominated (erratic)'] as const;
const MAX_MIN = 14 * 24 * 60;

export interface ZoneFact {
  zone: string; // zone id, must be one of ZONES
  tier: AlertTier;
  burning: boolean;
  etaMin: number; // earliest plausible arrival, minutes from now
  etaLatestMin: number | null;
  fireDir: string | null; // compass, from the zone toward the fire
  fireKm: number | null;
}
export interface CtxFact {
  windMph: number;
  windFrom: string;
  behaviour: (typeof BEHAVIOURS)[number];
  spotFires: number;
}
export type AlertLang = 'en' | 'both';
export interface ModelAlert {
  zone: string;
  sms_en?: string;
  long_en?: string;
  sms_es?: string;
  long_es?: string;
}

export const zoneName = (id: string) => zoneById(id)?.name ?? '';
/** Most zones the browser may send in one /api/alerts request (keeps each model call small and fast). */
export const MAX_ZONES_PER_REQUEST = 8;

// ---------- 1. Validate the request (structured facts only) ----------
const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

export function sanitizeRequest(body: unknown): { facts: ZoneFact[]; ctx: CtxFact; lang: AlertLang } | { error: string } {
  const b = body as { zones?: unknown; ctx?: unknown; lang?: unknown } | null;
  if (!b || !Array.isArray(b.zones) || b.zones.length === 0 || b.zones.length > MAX_ZONES_PER_REQUEST) return { error: `zones[] required (1..${MAX_ZONES_PER_REQUEST})` };
  const facts: ZoneFact[] = [];
  const seen = new Set<string>();
  for (const raw of b.zones as Record<string, unknown>[]) {
    const id = String(raw?.zone ?? '');
    if (!zoneById(id) || seen.has(id)) return { error: `unknown or duplicate zone "${id.slice(0, 8)}"` };
    seen.add(id);
    const tier = TIERS.find((t) => t === raw.tier);
    if (!tier) return { error: `bad tier for zone ${id}` };
    const eta = num(raw.etaMin, 0, MAX_MIN);
    if (eta === null) return { error: `bad etaMin for zone ${id}` };
    const late = raw.etaLatestMin === null || raw.etaLatestMin === undefined ? null : num(raw.etaLatestMin, eta, MAX_MIN);
    if (raw.etaLatestMin != null && late === null) return { error: `bad etaLatestMin for zone ${id}` };
    const dir = raw.fireDir == null ? null : COMPASS16.includes(String(raw.fireDir)) ? String(raw.fireDir) : undefined;
    if (dir === undefined) return { error: `bad fireDir for zone ${id}` };
    const km = raw.fireKm == null ? null : num(raw.fireKm, 0, 100);
    if (raw.fireKm != null && km === null) return { error: `bad fireKm for zone ${id}` };
    facts.push({ zone: id, tier, burning: raw.burning === true, etaMin: Math.round(eta), etaLatestMin: late === null ? null : Math.round(late), fireDir: dir, fireKm: km === null ? null : Math.round(km * 10) / 10 });
  }
  const c = (b.ctx ?? {}) as Record<string, unknown>;
  const windMph = num(c.windMph, 0, 200);
  const windFrom = COMPASS16.includes(String(c.windFrom)) ? String(c.windFrom) : null;
  const behaviour = BEHAVIOURS.find((x) => x === c.behaviour) ?? 'wind-driven';
  const spotFires = num(c.spotFires, 0, 1e6);
  if (windMph === null || windFrom === null || spotFires === null) return { error: 'bad ctx' };
  return { facts, ctx: { windMph: Math.round(windMph), windFrom, behaviour, spotFires: Math.round(spotFires) }, lang: b.lang === 'en' ? 'en' : 'both' };
}

// ---------- 2. Build the prompt on the server ----------
export const SYSTEM_PROMPT = `You write public wildfire evacuation alerts for an incident commander's planning tool.
Rules:
- Terms: "EVACUATION ORDER" means leave now (immediate threat). "EVACUATION WARNING" means prepare to leave (potential threat). "MONITOR" means stay alert. Never call an order a warning or vice versa.
- The alert tier for each zone is already decided. Never change it, never upgrade or downgrade it.
- Use ONLY the facts given (times, wind, fire direction, distance). Never invent roads, shelters, phone numbers, websites, or times. Do not add any number that is not in the facts.
- Say "follow official evacuation routes" instead of naming any route.
- The mph figure is WIND speed, not fire speed. Never write that the fire moves at that speed; say "winds 34 mph" if you mention it.
- Write times exactly as given (e.g. "1h 55m" or "45m").
- SMS: at most 160 characters. Start exactly like "EVACUATION ORDER Zone ALTA-2 (Altadena):" (tier in capitals, the zone ID exactly as given, place name in brackets), then plain words and one clear action.
- Long: 2-3 short sentences: what is happening, when, what to do. End with: "Estimate from a simplified fire model, not an official forecast."
- Spanish (when asked): natural Latin American Spanish, same facts, same rules; start like "ORDEN DE EVACUACIÓN Zona ALTA-2 (Altadena):"; tier words: ORDEN DE EVACUACIÓN / ADVERTENCIA DE EVACUACIÓN / MANTÉNGASE ALERTA. End the long version with: "Estimación de un modelo simplificado, no es un pronóstico oficial."
- Output ONLY JSON: {"alerts":[{"zone":"ALTA-2","sms_en":"...","long_en":"...","sms_es":"...","long_es":"..."}]} (omit _es fields if Spanish not requested).`;

export function etaStrings(f: ZoneFact): { earliest: string; range: string } {
  if (f.burning) return { earliest: 'now', range: 'fire is inside the zone' };
  const lo = fmtDuration(f.etaMin);
  const hi = f.etaLatestMin !== null ? fmtDuration(f.etaLatestMin) : null;
  return { earliest: lo, range: hi && hi !== lo ? `${lo}–${hi}` : lo };
}

export function buildMessages(facts: ZoneFact[], ctx: CtxFact, lang: AlertLang): { role: 'system' | 'user'; content: string }[] {
  const zones = facts.map((f) => ({
    zone: f.zone,
    name: zoneName(f.zone), // from the server's own zone list, never from the request
    tier: f.tier,
    fire_inside_zone: f.burning,
    earliest_arrival: etaStrings(f).earliest,
    arrival_range: etaStrings(f).range,
    fire_direction_from_zone: f.fireDir,
    fire_distance_km: f.fireKm,
  }));
  const user =
    `Wind: ${ctx.windMph} mph from the ${ctx.windFrom}. Fire behavior: ${ctx.behaviour}. Spot fires so far: ${ctx.spotFires}.\n` +
    `Languages: ${lang === 'both' ? 'English and Spanish' : 'English only'}.\n` +
    `Zones (tier already assigned):\n${JSON.stringify(zones, null, 1)}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export function parseModelJson(content: string): ModelAlert[] | null {
  const a = content.indexOf('{');
  const b = content.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(content.slice(a, b + 1));
    return Array.isArray(j?.alerts) ? (j.alerts as ModelAlert[]) : null;
  } catch {
    return null;
  }
}

// ---------- 3. Fact-check the model's output ----------
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/** Every duration mentioned, in minutes ("1h 55m", "45m", "45 min", "2 hours", "2 horas"). */
function durationsIn(s: string): number[] {
  const out: number[] = [];
  const re = /(\d+)\s*(?:h|hr|hrs|hour|hours|hora|horas)\b\s*(?:(\d+)\s*(?:m|min|mins|minutes|minutos)\b)?|(\d+)\s*(?:m|min|mins|minutes|minutos)\b/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    if (m[3]) out.push(Number(m[3]));
    else out.push(Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0));
  }
  return out;
}

/** Problems with one language's SMS + long text (empty = passes). */
function checkText(sms: unknown, long: unknown, f: ZoneFact, ctx: CtxFact, es: boolean): string[] {
  const bad: string[] = [];
  if (typeof sms !== 'string' || typeof long !== 'string' || !sms.trim() || !long.trim()) return ['missing text'];
  if (sms.length > 200) bad.push('SMS too long');
  if (long.length > 900) bad.push('long text too long');
  const both = `${sms}\n${long}`;
  const tierWord = es ? TIER_ES[f.tier] : f.tier;
  const lead = norm(`${tierWord} ${es ? 'Zona' : 'Zone'} ${f.zone}`);
  if (!norm(sms).startsWith(lead)) bad.push(`SMS must start with "${tierWord} ${es ? 'Zona' : 'Zone'} ${f.zone}"`);
  // no other tier's words (an order must never read as a warning, or vice versa)
  for (const t of TIERS) {
    if (t === f.tier) continue;
    const other = norm(es ? TIER_ES[t] : t);
    if (norm(both).includes(other)) bad.push(`mentions another tier (${es ? TIER_ES[t] : t})`);
  }
  if (/https?:|www\.|\.(com|org|gov|net)\b/i.test(both)) bad.push('contains a link');
  if (/\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b911\b/.test(both)) bad.push('contains a phone number');
  // numbers must come from the facts
  for (const m of both.matchAll(/(\d+(?:\.\d+)?)\s*mph/gi)) if (Math.abs(Number(m[1]) - ctx.windMph) > 1) bad.push(`wind ${m[1]} mph not in facts`);
  for (const m of both.matchAll(/(\d+(?:[.,]\d+)?)\s*km\b/gi)) {
    const v = Number(m[1].replace(',', '.'));
    if (f.fireKm === null || Math.abs(v - f.fireKm) > 0.25) bad.push(`distance ${m[1]} km not in facts`);
  }
  const allowed = [f.etaMin, f.etaLatestMin].filter((x): x is number => x !== null);
  for (const d of durationsIn(both)) {
    if (!allowed.some((a) => Math.abs(a - d) <= Math.max(5, a * 0.1))) bad.push(`time ${fmtDuration(d)} not in facts`);
  }
  const disclaimer = es ? 'NO ES UN PRONOSTICO OFICIAL' : 'NOT AN OFFICIAL FORECAST';
  if (!norm(long).includes(disclaimer)) bad.push('missing disclaimer');
  return bad;
}

/** Fact-check one model alert against the zone's facts. Empty array = safe to use. */
export function factCheck(a: ModelAlert | undefined, f: ZoneFact, ctx: CtxFact, lang: AlertLang): string[] {
  if (!a) return ['model returned nothing for this zone'];
  const bad = checkText(a.sms_en, a.long_en, f, ctx, false);
  if (lang === 'both') bad.push(...checkText(a.sms_es, a.long_es, f, ctx, true).map((x) => `ES: ${x}`));
  return [...new Set(bad)];
}

/** Light check for text the server is asked to forward (webhook). */
export function forwardableSms(sms: unknown, zone: string, tier: AlertTier): string | null {
  if (typeof sms !== 'string' || sms.length > 200) return null;
  const s = norm(sms);
  if (!(s.startsWith(norm(`${tier} Zone ${zone}`)) || s.startsWith(norm(`${TIER_ES[tier]} Zona ${zone}`)))) return null;
  if (/https?:|www\.|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/i.test(sms)) return null;
  return sms;
}
