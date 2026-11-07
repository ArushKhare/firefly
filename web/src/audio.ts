// Audio warnings: Deepgram TTS via /api/tts, cached blob URLs, an alert tone, and a play queue.
// Audio is optional: if TTS is unavailable the UI simply hides play buttons.

let ttsAvailable: boolean | null = null;
const cache = new Map<string, string>(); // key -> blob URL
let ctx: AudioContext | null = null;
let queue: (() => Promise<void>)[] = [];
let playing = false;
let current: HTMLAudioElement | null = null;
let endCurrent: (() => void) | null = null;
let gen = 0;
let muted = (() => {
  try {
    return localStorage.getItem('audio-muted') === '1';
  } catch {
    return false;
  }
})();

export function isMuted(): boolean {
  return muted;
}

/** Global mute for announcement audio (tone + speech). Muting also stops anything playing. */
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('audio-muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (m) stop();
} // bumped by stop(); stale queued clips skip themselves

export async function checkTts(): Promise<boolean> {
  if (ttsAvailable !== null) return ttsAvailable;
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
    ttsAvailable = r.ok && !!(await r.json()).tts;
  } catch {
    ttsAvailable = false;
  }
  return ttsAvailable;
}

export { speechScript } from './speech.ts';

/**
 * Streaming URL for a clip. The server streams Deepgram audio as it is generated (first sound in
 * ~0.5 s instead of waiting ~5 s for the whole clip) and caches finished clips for instant replays.
 */
export function clipUrl(zone: string, tier: string, etaMin: number, lang: 'en' | 'es'): string {
  // structured request: the server builds the spoken script itself (it won't speak arbitrary text)
  return `/api/tts?lang=${lang}&zone=${encodeURIComponent(zone)}&tier=${encodeURIComponent(tier)}&eta=${Math.round(etaMin)}`;
}

/** Warm the server cache for a clip without playing it (fire-and-forget). Returns its URL. */
export function prefetch(zone: string, tier: string, etaMin: number, lang: 'en' | 'es'): string {
  const url = clipUrl(zone, tier, etaMin, lang);
  if (!cache.has(url)) {
    cache.set(url, url);
    fetch(url)
      .then((r) => r.arrayBuffer())
      .catch((err) => {
        cache.delete(url);
        console.warn('TTS warm-up failed', err);
      });
  }
  return url;
}

/** Two-tone attention signal (853 + 960 Hz, like broadcast emergency alerts), ~1 s. */
function tone(): Promise<void> {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.15, t0 + 0.03);
    gain.gain.setValueAtTime(0.15, t0 + 0.95);
    gain.gain.linearRampToValueAtTime(0, t0 + 1.0);
    gain.connect(ctx.destination);
    for (const f of [853, 960]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(gain);
      o.start(t0);
      o.stop(t0 + 1.0);
    }
    return new Promise((res) => setTimeout(res, 1100));
  } catch {
    return Promise.resolve();
  }
}

function playUrl(url: string): Promise<void> {
  return new Promise((res) => {
    endCurrent = res;
    current = new Audio(url);
    current.onended = () => res();
    current.onerror = () => res();
    current.play().catch(() => res());
  });
}

async function drain(): Promise<void> {
  if (playing) return;
  playing = true;
  while (queue.length) await queue.shift()!();
  playing = false;
}

/** Queue clips (tone + speech each). replace=true stops what's playing first. */
export function playClips(urls: string[], replace = true): void {
  if (muted) return;
  if (replace) stop();
  const g = gen;
  for (const u of urls) {
    queue.push(async () => {
      if (g !== gen) return;
      await tone();
      if (g !== gen) return;
      await playUrl(u);
    });
  }
  void drain();
}

export function stop(): void {
  gen++;
  queue = [];
  if (current) {
    current.pause();
    current = null;
  }
  endCurrent?.(); // unblock the queue loop
  endCurrent = null;
}
