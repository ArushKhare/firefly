// Evacuation warnings: tiers are deterministic code; the LLM only writes the wording.
import { fmtDuration } from './units.ts';

export type Tier = 'EVACUATION ORDER' | 'EVACUATION WARNING' | 'MONITOR';
export type Lang = 'en' | 'es' | 'both';

export const TIER_ORDER: Tier[] = ['EVACUATION ORDER', 'EVACUATION WARNING', 'MONITOR'];

/**
 * Predictive trigger (evacuation "trigger point" logic): people need clearanceMin to get out,
 * so order when the earliest plausible fire arrival leaves less than clearance + ORDER_BUFFER;
 * warn when it's within clearance + WARNING_LEAD; monitor within MONITOR_MIN.
 */
export const TRIGGER = { ORDER_BUFFER: 30, WARNING_LEAD: 150, MONITOR_MIN: 480 };

export function tierFor(etaMin: number | null, clearanceMin = 30): Tier | null {
  if (etaMin === null || !isFinite(etaMin)) return null;
  if (etaMin < clearanceMin + TRIGGER.ORDER_BUFFER) return 'EVACUATION ORDER';
  if (etaMin < clearanceMin + TRIGGER.WARNING_LEAD) return 'EVACUATION WARNING';
  if (etaMin < Math.max(TRIGGER.MONITOR_MIN, clearanceMin + TRIGGER.WARNING_LEAD + 60)) return 'MONITOR';
  return null;
}

/** Minutes until this zone's order trigger is reached (null if no arrival predicted). */
export function minutesToOrder(z: ZoneSituation): number | null {
  if (z.burningPct > 0) return 0;
  if (z.etaEarliest === null) return null;
  return Math.max(0, z.etaEarliest - (z.clearanceMin + TRIGGER.ORDER_BUFFER));
}

export interface ZoneSituation {
  id: string;
  name: string;
  clearanceMin: number; // estimated time for residents to get out
  burningPct: number; // >0 means fire is already inside the zone
  etaBase: number | null; // minutes from now, best-estimate run
  etaEarliest: number | null; // minutes from now, earliest plausible (10th pct of runs) -> drives the tier
  etaLatest: number | null;
  reachedPct: number | null; // % of uncertainty runs reaching the zone in 12 h
  fireDir: string | null; // compass direction of nearest fire, seen from the zone
  fireKm: number | null;
}

export interface FireContext {
  windMph: number;
  windFrom: string;
  behaviour: string; // wind-driven / transitional / plume-dominated
  spotFires: number;
}

export interface Alert {
  zoneId: string;
  zoneName: string;
  tier: Tier;
  etaMin: number; // earliest plausible, minutes from now (0 if burning)
  etaText: string;
  smsEn: string;
  longEn: string;
  smsEs?: string;
  longEs?: string;
  source: 'ai' | 'template';
  checkNote?: string; // fact-check result shown on the card
}

const SMS_MAX = 160;
const clampSms = (s: string) => (s.length <= SMS_MAX ? s : s.slice(0, SMS_MAX - 1).replace(/\s+\S*$/, '') + '…');

export function etaText(z: ZoneSituation): string {
  if (z.burningPct > 0) return `fire inside zone (${z.burningPct.toFixed(0)}% burned)`;
  if (z.etaEarliest === null) return 'not expected within 12 h';
  const lo = fmtDuration(z.etaEarliest);
  const hi = z.etaLatest !== null ? fmtDuration(z.etaLatest) : null;
  return hi && hi !== lo ? `${lo}–${hi}` : `~${lo}`;
}

/** Which zones get an alert, most urgent first. Fire already inside a zone = EVACUATION ORDER. */
export function assignTiers(zones: ZoneSituation[]): { zone: ZoneSituation; tier: Tier; etaMin: number }[] {
  const out: { zone: ZoneSituation; tier: Tier; etaMin: number }[] = [];
  for (const z of zones) {
    const eta = z.burningPct > 0 ? 0 : z.etaEarliest;
    const tier = z.burningPct > 0 ? 'EVACUATION ORDER' : tierFor(eta, z.clearanceMin);
    if (tier && eta !== null) out.push({ zone: z, tier, etaMin: eta });
  }
  return out.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.etaMin - b.etaMin);
}

// ---------- Template fallback (used when the LLM is unavailable) ----------
const ES_TIER: Record<Tier, string> = {
  'EVACUATION ORDER': 'ORDEN DE EVACUACIÓN',
  'EVACUATION WARNING': 'ADVERTENCIA DE EVACUACIÓN',
  MONITOR: 'MANTÉNGASE ALERTA',
};

function templateAlert(z: ZoneSituation, tier: Tier, etaMin: number, ctx: FireContext, lang: Lang): Alert {
  const when = z.burningPct > 0 ? 'Fire is in the area' : `Fire may arrive in ${etaText(z)}`;
  const whenEs = z.burningPct > 0 ? 'Hay fuego en el área' : `El fuego podría llegar en ${etaText(z)}`;
  const action =
    tier === 'EVACUATION ORDER' ? 'Leave now by official routes.' : tier === 'EVACUATION WARNING' ? 'Pack essentials, be ready to go.' : 'Stay alert for updates.';
  const actionEs =
    tier === 'EVACUATION ORDER' ? 'Salga ya por rutas oficiales.' : tier === 'EVACUATION WARNING' ? 'Prepare lo esencial y esté listo.' : 'Esté atento a avisos.';
  const a: Alert = {
    zoneId: z.id,
    zoneName: z.name,
    tier,
    etaMin,
    etaText: etaText(z),
    smsEn: clampSms(`${tier}: Zone ${z.id} ${z.name}. ${when}. ${action}`),
    longEn:
      `${when} for Zone ${z.id} (${z.name}); wind ${ctx.windMph.toFixed(0)} mph from the ${ctx.windFrom}. ${action} ` +
      `Estimate from a simplified fire model, not an official forecast. Follow local officials.`,
    source: 'template',
  };
  if (lang !== 'en') {
    a.smsEs = clampSms(`${ES_TIER[tier]}: Zona ${z.id} ${z.name}. ${whenEs}. ${actionEs}`);
    a.longEs =
      `${whenEs} para la Zona ${z.id} (${z.name}); viento de ${ctx.windMph.toFixed(0)} mph del ${ctx.windFrom}. ${actionEs} ` +
      `Estimación de un modelo simplificado, no es un pronóstico oficial. Siga a las autoridades locales.`;
  }
  return a;
}

// ---------- AI wording (server-side prompt + fact-check) ----------
// The browser sends only structured facts; the server builds the prompt, calls the fast model and
// fact-checks every draft (tier words, zone, times, wind, distance, no links/phone numbers).
// Drafts that fail are replaced by the fixed template, with the reason shown on the card.
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const BEHAV = ['wind-driven', 'transitional', 'plume-dominated (erratic)'];

/** Generate alerts. Never throws: falls back to templates per zone. */
export async function writeAlerts(zones: ZoneSituation[], ctx: FireContext, lang: Lang): Promise<{ alerts: Alert[]; note: string }> {
  const tiered = assignTiers(zones);
  if (tiered.length === 0) return { alerts: [], note: 'No zone is within 8 h of the fire. No alerts needed.' };
  const templates = tiered.map((t) => templateAlert(t.zone, t.tier, t.etaMin, ctx, lang));
  const body = {
    lang: lang === 'en' ? 'en' : 'both',
    ctx: {
      windMph: Math.round(ctx.windMph),
      windFrom: DIRS.includes(ctx.windFrom) ? ctx.windFrom : 'N',
      behaviour: BEHAV.includes(ctx.behaviour) ? ctx.behaviour : 'wind-driven',
      spotFires: ctx.spotFires,
    },
    zones: tiered.map((t) => ({
      zone: t.zone.id,
      tier: t.tier,
      burning: t.zone.burningPct > 0,
      etaMin: Math.round(t.etaMin),
      etaLatestMin: t.zone.etaLatest !== null ? Math.round(Math.max(t.etaMin, t.zone.etaLatest)) : null,
      fireDir: t.zone.fireDir,
      fireKm: t.zone.fireKm !== null ? Math.round(t.zone.fireKm * 10) / 10 : null,
    })),
  };
  try {
    const r = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) throw new Error(`/api/alerts ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const data = (await r.json()) as { alerts: ({ zone: string; rejected?: string[] } & Record<string, string>)[] };
    let used = 0;
    let rejected = 0;
    const alerts = templates.map((tpl) => {
      const got = data.alerts.find((x) => x.zone === tpl.zoneId);
      if (!got || got.rejected) {
        rejected++;
        return { ...tpl, checkNote: got?.rejected ? `AI draft failed fact-check: ${got.rejected.slice(0, 2).join('; ')}` : 'AI draft missing' };
      }
      used++;
      const a: Alert = { ...tpl, smsEn: clampSms(got.sms_en), longEn: got.long_en, source: 'ai', checkNote: 'AI · fact-checked ✓' };
      if (lang !== 'en' && got.sms_es) {
        a.smsEs = clampSms(got.sms_es);
        a.longEs = got.long_es;
      }
      return a;
    });
    const note = rejected
      ? `AI wrote ${used}/${alerts.length}; ${rejected} draft(s) failed the fact-check and were replaced by templates.`
      : 'Written by AI from simulator facts, fact-checked.';
    return { alerts, note };
  } catch (err) {
    console.warn('alert AI failed, using templates', err);
    return { alerts: templates, note: `AI unavailable (${String(err).slice(0, 80)}). Using templates.` };
  }
}
