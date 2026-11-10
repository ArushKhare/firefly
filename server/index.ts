// FireFly backend: proxies OpenRouter (LLM) and Deepgram (TTS) so keys never reach the browser.
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechScript, type SpeechTier } from '../web/src/speech.ts';
import { TIERS, buildMessages, factCheck, forwardableSms, parseModelJson, sanitizeRequest, zoneName, type AlertTier } from '../web/src/alertsCore.ts';

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-5.5';
// Alerts need speed over depth: a fast, non-reasoning model (benchmarked ~2-3 s vs ~8 s for Sonnet)
const ALERT_MODEL = process.env.ALERT_MODEL || 'google/gemini-3.5-flash-lite';
const TTS_VOICE = process.env.TTS_VOICE || 'aura-2-thalia-en';
const TTS_VOICE_ES = process.env.TTS_VOICE_ES || 'aura-2-celeste-es';
// TTS route: 'openrouter' (deepgram/aura-2 via OpenRouter, same key as the LLM) or 'deepgram' (direct).
// Default: OpenRouter unless only a Deepgram key is set.
const TTS_VIA =
  process.env.TTS_VIA === 'deepgram' || process.env.TTS_VIA === 'openrouter'
    ? process.env.TTS_VIA
    : process.env.OPENROUTER_API_KEY || !process.env.DEEPGRAM_API_KEY
      ? 'openrouter'
      : 'deepgram';
const ttsKey = () => (TTS_VIA === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.DEEPGRAM_API_KEY);
const REFERER = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:5173');
const LLM_TIMEOUT_MS = 45000;
const TTS_TIMEOUT_MS = 15000;

const app = express();
app.set('trust proxy', true); // behind Railway's proxy: real client IP for rate limits
app.use(express.json({ limit: '256kb' }));

// ---------- Guardrails for a public deployment ----------
// Optional site password (HTTP Basic auth, any username). Set APP_PASSWORD to enable.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization ?? '';
    const pass = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass === APP_PASSWORD) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="FireFly"');
    res.status(401).send('Password required');
  });
}
// Simple per-IP rate limits (in memory, per minute)
const hits = new Map<string, { n: number; reset: number }>();
function limit(perMinute: number): express.RequestHandler {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now > h.reset) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++h.n > perMinute) {
      res.status(429).json({ error: 'Too many requests, slow down' });
      return;
    }
    next();
  };
}
app.use('/api/chat', limit(20));
app.use('/api/alerts', limit(40)); // big fires send alerts in batches of 8 zones
app.use('/api/tts', limit(120));
app.use('/api/dispatch', limit(20));
// Production: no general chat endpoint, no free-text speech. Dev keeps them for experiments.
const DEV = process.env.NODE_ENV !== 'production';
const ALLOW_GENERAL_CHAT = process.env.ALLOW_GENERAL_CHAT === '1' || DEV;
const ALLOW_FREE_TTS = process.env.ALLOW_FREE_TTS === '1' || DEV;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    llm: !!process.env.OPENROUTER_API_KEY,
    tts: !!ttsKey(),
    ttsVia: TTS_VIA,
    model: MODEL,
    alertModel: ALERT_MODEL,
    voices: { en: TTS_VOICE, es: TTS_VOICE_ES },
    webhook: WEBHOOK_URL ? WEBHOOK_KIND : null,
  });
});

// POST /api/chat  { messages, tools?, max_tokens? } -> raw OpenRouter chat completion JSON
app.post('/api/chat', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'OPENROUTER_API_KEY not set on server' });
    return;
  }
  const { messages, tools, max_tokens, reasoning, purpose } = req.body ?? {};
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages[] required' });
    return;
  }
  if (!ALLOW_GENERAL_CHAT) {
    res.status(403).json({ error: 'disabled on this deployment (alerts go through /api/alerts)' });
    return;
  }
  if (JSON.stringify(messages).length > 20000) {
    res.status(413).json({ error: 'prompt too large' });
    return;
  }
  const model = purpose === 'alerts' ? ALERT_MODEL : MODEL;
  const body: Record<string, unknown> = { model, messages, max_tokens: Math.min(Number(max_tokens) || 1500, purpose === 'alerts' ? 2000 : 6000) };
  // Optional OpenRouter reasoning control, e.g. { effort: 'low' } for fast structured writing
  if (reasoning && typeof reasoning === 'object' && ['low', 'medium', 'high'].includes(String(reasoning.effort))) {
    body.reasoning = { effort: reasoning.effort };
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  try {
    const r = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': REFERER,
          'X-Title': 'FireFly',
        },
        body: JSON.stringify(body),
      },
      LLM_TIMEOUT_MS,
    );
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (err) {
    res.status(504).json({ error: `OpenRouter request failed: ${String(err)}` });
  }
});

// ---------- POST /api/alerts: structured facts in, fact-checked alert text out ----------
// The browser sends only zone ids, tiers and numbers. The server validates them, builds the prompt from
// its own zone list, calls the fast model, and fact-checks every alert before returning it.
app.post('/api/alerts', async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'OPENROUTER_API_KEY not set on server' });
    return;
  }
  const clean = sanitizeRequest(req.body);
  if ('error' in clean) {
    res.status(400).json({ error: clean.error });
    return;
  }
  const { facts, ctx, lang } = clean;
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': REFERER, 'X-Title': 'FireFly' },
        body: JSON.stringify({ model: ALERT_MODEL, messages: buildMessages(facts, ctx, lang), max_tokens: 2000 }),
      },
      LLM_TIMEOUT_MS,
    );
    if (!r.ok) {
      res.status(502).json({ error: `model ${r.status}` });
      return;
    }
    const data = await r.json();
    const drafts = parseModelJson(String(data?.choices?.[0]?.message?.content ?? '')) ?? [];
    const alerts = facts.map((f) => {
      const draft = drafts.find((d) => String(d?.zone ?? '').toUpperCase() === f.zone);
      const problems = factCheck(draft, f, ctx, lang);
      if (problems.length) {
        console.warn(`[alerts] zone ${f.zone} draft rejected: ${problems.join('; ')}`);
        return { zone: f.zone, rejected: problems };
      }
      return {
        zone: f.zone,
        sms_en: draft!.sms_en!.trim(),
        long_en: draft!.long_en!.trim(),
        ...(lang === 'both' ? { sms_es: draft!.sms_es!.trim(), long_es: draft!.long_es!.trim() } : {}),
      };
    });
    res.json({ model: ALERT_MODEL, ms: Date.now() - t0, alerts });
  } catch (err) {
    res.status(504).json({ error: `model request failed: ${String(err).slice(0, 120)}` });
  }
});

// ---------- Text-to-speech: streamed, cached, de-duplicated ----------
// Deepgram generates roughly in real time (~0.5 s to first byte, ~5 s for a full clip), so we stream the
// audio to the browser as it arrives and keep finished clips in memory for instant replays.
const ttsCache = new Map<string, Buffer>();
const ttsInflight = new Map<string, Promise<Buffer | null>>();
const TTS_CACHE_MAX = 300;
const ttsKeyOf = (text: string, lang: string) => `${lang}|${text}`;

function ttsUpstream(text: string, lang: 'en' | 'es'): Promise<Response> {
  const key = ttsKey()!;
  const voice = lang === 'es' ? TTS_VOICE_ES : TTS_VOICE;
  return TTS_VIA === 'openrouter'
    ? fetchWithTimeout(
        'https://openrouter.ai/api/v1/audio/speech',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': REFERER, 'X-Title': 'FireFly' },
          body: JSON.stringify({ model: 'deepgram/aura-2', input: text, voice, response_format: 'mp3' }),
        },
        TTS_TIMEOUT_MS,
      )
    : fetchWithTimeout(
        `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}`,
        { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
        TTS_TIMEOUT_MS,
      );
}

function remember(k: string, buf: Buffer): void {
  ttsCache.set(k, buf);
  if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value!);
}

/**
 * Stream a clip from upstream. `onChunk` receives audio as it arrives (for live playback); resolves with
 * the whole clip (cached) or null on failure. Concurrent requests for the same clip share one upstream call.
 */
function streamClip(text: string, lang: 'en' | 'es', onChunk?: (c: Uint8Array) => void): Promise<Buffer | null> {
  const k = ttsKeyOf(text, lang);
  const hit = ttsCache.get(k);
  if (hit) {
    onChunk?.(hit);
    return Promise.resolve(hit);
  }
  const pending = ttsInflight.get(k);
  if (pending) return pending.then((b) => (b && onChunk?.(b), b));
  const p = (async () => {
    try {
      const r = await ttsUpstream(text, lang);
      if (!r.ok || !r.body) {
        console.warn(`TTS (${TTS_VIA}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return null;
      }
      const parts: Uint8Array[] = [];
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        parts.push(chunk);
        onChunk?.(chunk);
      }
      const buf = Buffer.concat(parts);
      remember(k, buf);
      return buf;
    } catch (err) {
      console.warn(`TTS (${TTS_VIA}) failed: ${String(err)}`);
      return null;
    } finally {
      ttsInflight.delete(k);
    }
  })();
  ttsInflight.set(k, p);
  return p;
}

/** Whole clip (used for ntfy attachments). */
async function synth(text: string, lang: 'en' | 'es'): Promise<{ buf: Buffer; type: string } | { status: number; error: string }> {
  if (!ttsKey()) return { status: 503, error: `TTS key not set (TTS_VIA=${TTS_VIA})` };
  const buf = await streamClip(text, lang);
  return buf ? { buf, type: 'audio/mpeg' } : { status: 502, error: 'TTS failed' };
}

/** GET /api/tts?text=...&lang=en  -> streamed mp3 (usable directly as <audio src>, starts in ~0.5 s) */
async function serveTts(text: string, lang: 'en' | 'es', res: express.Response): Promise<void> {
  if (!ttsKey()) {
    res.status(503).json({ error: `TTS key not set (TTS_VIA=${TTS_VIA})` });
    return;
  }
  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  let started = false;
  const buf = await streamClip(text, lang, (c) => {
    started = true;
    res.write(c);
  });
  if (!buf && !started) {
    res.status(502).json({ error: 'TTS failed' });
    return;
  }
  res.end();
}
/**
 * GET /api/tts?zone=E&tier=EVACUATION%20ORDER&eta=45&lang=en
 * The server builds the spoken script from its own zone list; callers can't make it say arbitrary words.
 * (Free text via ?text= only in development.)
 */
function ttsTextFrom(q: Record<string, unknown>): string | null {
  const lang = q.lang === 'es' ? 'es' : 'en';
  if (q.zone !== undefined) {
    const name = zoneName(String(q.zone));
    const tier = TIERS.find((t) => t === q.tier);
    const eta = Number(q.eta);
    if (!name || !tier || !Number.isFinite(eta) || eta < 0 || eta > 20160) return null;
    return speechScript(name, tier as SpeechTier, Math.round(eta), lang);
  }
  if (ALLOW_FREE_TTS && typeof q.text === 'string') return q.text.slice(0, 600);
  return null;
}
for (const method of ['get', 'post'] as const) {
  app[method]('/api/tts', (req, res) => {
    const q = (method === 'get' ? req.query : req.body ?? {}) as Record<string, unknown>;
    const text = ttsTextFrom(q);
    if (!text) {
      res.status(400).json({ error: 'expected zone, tier and eta' });
      return;
    }
    void serveTts(text, q.lang === 'es' ? 'es' : 'en', res);
  });
}

// ---------- Alert dispatch (optional webhook: slack | discord | ntfy | json) ----------
// Every message is forced to carry SIM_PREFIX so it can never pass as a real public alert.
const SIM_PREFIX = '[SIMULATION - FireFly demo, not a real alert]';
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const WEBHOOK_KIND = (process.env.ALERT_WEBHOOK_KIND || 'json').toLowerCase();
const PRIORITY: Record<string, string> = { 'EVACUATION ORDER': '5', 'EVACUATION WARNING': '4', MONITOR: '3' };
const WEBHOOK_AUDIO = process.env.ALERT_WEBHOOK_AUDIO !== 'false';

/** HTTP headers must be ASCII; ntfy decodes RFC 2047 encoded-words for UTF-8 (Spanish accents). */
function rfc2047(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** One mp3: English script, then Spanish if wanted. Same encoder settings, so frames concatenate cleanly. */
async function spokenClip(town: string, tier: SpeechTier, etaMin: number, withEs: boolean): Promise<Buffer | null> {
  // English and Spanish synthesised in parallel
  const [en, es] = await Promise.all([
    synth(`Simulation. ${speechScript(town, tier, etaMin, 'en')}`, 'en'),
    withEs ? synth(`Simulación. ${speechScript(town, tier, etaMin, 'es')}`, 'es') : Promise.resolve(null),
  ]);
  if ('error' in en) return null;
  if (!es) return en.buf;
  return 'error' in es ? en.buf : Buffer.concat([en.buf, es.buf]);
}

app.post('/api/dispatch', async (req, res) => {
  const alerts = Array.isArray(req.body?.alerts) ? req.body.alerts.slice(0, 10) : [];
  if (!WEBHOOK_URL) {
    res.json({ sent: false, reason: 'ALERT_WEBHOOK_URL not set' });
    return;
  }
  const results: { zone: string; ok: boolean; status?: number; error?: string }[] = [];
  for (const a of alerts) {
    // only forward well-formed alerts for known zones (no arbitrary text to the webhook)
    const tierOk = TIERS.find((t) => t === a.tier) as AlertTier | undefined;
    if (!tierOk || !zoneName(String(a.zone)) || !forwardableSms(a.sms, String(a.zone), tierOk)) {
      results.push({ zone: String(a.zone).slice(0, 4), ok: false, error: 'rejected: not a valid FireFly alert' });
      continue;
    }
    a.smsEs = a.smsEs ? forwardableSms(a.smsEs, String(a.zone), tierOk) : undefined;
    a.name = zoneName(String(a.zone));
    const tier = String(a.tier ?? '');
    const lines = [String(a.sms ?? '').slice(0, 200), a.smsEs ? String(a.smsEs).slice(0, 200) : ''].filter(Boolean);
    const text = `${SIM_PREFIX}\n${lines.join('\n')}`;
    let init: RequestInit;
    if (WEBHOOK_KIND === 'ntfy') {
      const headers: Record<string, string> = {
        Title: rfc2047(`${tier} - Zone ${a.zone} (SIMULATION)`),
        Priority: PRIORITY[tier] ?? '3',
        Tags: tier === 'EVACUATION ORDER' ? 'rotating_light,fire,sos' : tier === 'EVACUATION WARNING' ? 'warning,fire' : 'eyes,fire',
      };
      // Spoken clip as an attachment (EN, then ES if present). Spoken text also says it's a simulation.
      const audio = WEBHOOK_AUDIO && tier !== 'MONITOR' ? await spokenClip(String(a.name ?? `Zone ${a.zone}`).slice(0, 60), tier as SpeechTier, Math.max(0, Number(a.etaMin) || 0), !!a.smsEs) : null;
      if (audio) {
        headers.Filename = `zone-${String(a.zone).replace(/[^A-Za-z0-9]/g, '')}-alert.mp3`;
        headers.Message = rfc2047(text);
        init = { method: 'PUT', headers, body: audio };
      } else {
        init = { method: 'POST', headers, body: text };
      }
    } else if (WEBHOOK_KIND === 'slack') {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };
    } else if (WEBHOOK_KIND === 'discord') {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) };
    } else {
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simulation: true, notice: SIM_PREFIX, ...a }) };
    }
    try {
      const r = await fetchWithTimeout(WEBHOOK_URL, init, 8000);
      results.push({ zone: String(a.zone), ok: r.ok, status: r.status });
    } catch (err) {
      results.push({ zone: String(a.zone), ok: false, error: String(err).slice(0, 120) });
    }
  }
  res.json({ sent: true, kind: WEBHOOK_KIND, results });
});

// ---------- Serve the built web app (single-service deploy) ----------
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { maxAge: '1h', index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`FireFly server on http://localhost:${PORT}  (llm: ${!!process.env.OPENROUTER_API_KEY}, tts: ${!!ttsKey()} via ${TTS_VIA}, model: ${MODEL}, alerts: ${ALERT_MODEL})`);
});
