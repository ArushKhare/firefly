// Warnings panel: tiered alert cards, audio, and AUTO mode.
// Auto mode watches zone tiers every second; when a zone enters a new or more urgent tier
// it writes alerts for just those zones and dispatches them (in-app, audio, desktop, webhook).
// Tiers never auto-downgrade, so model noise can't make alerts flip-flop.
import { checkTts, clipUrl, isMuted, playClips, prefetch, setMuted, stop } from '../audio.ts';
import { assignTiers, TIER_ORDER, writeAlerts, type Alert, type FireContext, type Lang, type Tier, type ZoneSituation } from '../warnings.ts';
import { fmtDuration } from '../units.ts';

const TIER_CLASS: Record<Tier, string> = { 'EVACUATION ORDER': 'evac', 'EVACUATION WARNING': 'prep', MONITOR: 'mon' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const rank = (t: Tier) => TIER_ORDER.indexOf(t); // 0 = most urgent

export interface Situation {
  zones: ZoneSituation[];
  ctx: FireContext;
  simTime: number;
  wallTime: Date;
  ready: boolean; // uncertainty runs finished for the current fire state
}

interface Dispatch {
  simTime: number;
  wall: string;
  zoneId: string;
  tier: Tier;
  reason: 'auto' | 'manual';
  channels: Record<string, string>; // channel -> status
}

const MIN_GAP_MS = 4000; // don't call the LLM more often than this in auto mode

export class WarningsPanel {
  private root: HTMLElement;
  private list: HTMLElement;
  private logEl: HTMLElement;
  private status: HTMLElement;
  private genBtn: HTMLButtonElement;
  private castBtn: HTMLButtonElement;
  private langSel: HTMLSelectElement;
  private autoChk: HTMLInputElement;
  private audioChk: HTMLInputElement;
  private notifyChk: HTMLInputElement;
  private alerts = new Map<string, Alert>(); // latest alert per zone
  private issued = new Map<string, Tier>(); // highest tier issued per zone
  private audio = new Map<string, string>(); // `${zone}|${lang}` -> blob url
  private log: Dispatch[] = [];
  private busy = false;
  private lastGen = 0;
  private lastSimTime = 0;
  private webhook: string | null = null;

  constructor(private getSituation: (withGeo: boolean) => Situation | null) {
    this.root = document.getElementById('warnings')!;
    this.root.innerHTML = `
      <div class="warn-bar">
        <button id="warn-gen" class="primary" hidden title="Write and send alerts for every zone at risk now">Generate &amp; send</button>
        <select id="warn-lang" title="Languages">
          <option value="en">English</option>
          <option value="both">English + Español</option>
        </select>
        <button id="warn-cast" title="Play EVACUATION ORDER zones first, then EVACUATION WARNING" hidden>📢 Broadcast all</button>
        <button id="warn-mute" title="Mute / unmute announcement audio"></button>
      </div>
      <div class="warn-auto">
        <label data-demo-hide><input type="checkbox" id="warn-auto" checked /> Auto-alert on escalation</label>
        <label data-demo-hide><input type="checkbox" id="warn-audio" checked /> Auto-broadcast audio</label>
        <label data-demo-hide><input type="checkbox" id="warn-notify" /> Desktop notifications</label>
      </div>
      <p id="warn-status" class="muted"></p>
      <div id="warn-list"></div>
      <details id="warn-log-wrap" open><summary>Dispatch log</summary><div id="warn-log" class="muted">Nothing sent yet.</div></details>`;
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.list = $('warn-list');
    this.logEl = $('warn-log');
    this.status = $('warn-status');
    this.genBtn = $('warn-gen');
    this.castBtn = $('warn-cast');
    this.langSel = $('warn-lang');
    this.autoChk = $('warn-auto');
    this.audioChk = $('warn-audio');
    this.notifyChk = $('warn-notify');
    const muteBtn = $<HTMLButtonElement>('warn-mute');
    const paintMute = () => {
      muteBtn.textContent = isMuted() ? '🔇 Muted' : '🔊 Sound on';
      muteBtn.classList.toggle('on', isMuted());
    };
    muteBtn.onclick = () => {
      setMuted(!isMuted());
      paintMute();
    };
    paintMute();
    this.genBtn.onclick = () => void this.issue('manual');
    // switching language re-sends the alerts currently in force, in the new language(s)
    this.langSel.onchange = () => {
      if (this.alerts.size) void this.issue('manual', [...this.alerts.keys()]);
    };
    this.castBtn.onclick = () => this.broadcast([...this.alerts.values()]);
    this.notifyChk.onchange = async () => {
      if (!this.notifyChk.checked || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') this.notifyChk.checked = false;
      }
    };
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-play]') as HTMLButtonElement | null;
      const url = b ? this.audio.get(b.dataset.play!) : undefined;
      if (url) playClips([url]);
    });
    void checkTts();
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => (this.webhook = h.webhook ?? null))
      .catch(() => {});
    this.updateStatusLine();
  }

  private updateStatusLine(extra = ''): void {
    const auto = this.autoChk.checked
      ? 'Automatic: alerts are written and sent the moment a zone escalates.'
      : 'Auto-alert off.';
    const hook = this.webhook ? ` Webhook: ${this.webhook}.` : '';
    this.status.textContent = `${extra ? extra + ' ' : ''}${auto}${hook}`;
  }

  /** Called every second by main. Detects resets and escalations. */
  tick(): void {
    const sit = this.getSituation(false);
    if (!sit) {
      if (this.issued.size) this.reset();
      return;
    }
    if (sit.simTime < this.lastSimTime - 1) this.reset(); // sim was reset
    this.lastSimTime = sit.simTime;
    this.refreshAges(sit);
    if (!this.autoChk.checked || this.busy || !sit.ready) return;
    if (performance.now() - this.lastGen < MIN_GAP_MS) return;
    const escalated = assignTiers(sit.zones).filter((t) => {
      const prev = this.issued.get(t.zone.id);
      return prev === undefined || rank(t.tier) < rank(prev);
    });
    if (escalated.length) void this.issue('auto', escalated.map((t) => t.zone.id));
  }

  reset(): void {
    stop();
    this.alerts.clear();
    this.issued.clear();
    this.audio.clear();
    this.log = [];
    this.lastSimTime = 0;
    this.render();
    this.renderLog();
    this.updateStatusLine();
  }

  /** Write + dispatch alerts. onlyZones limits to escalated zones (auto mode). */
  async issue(reason: 'auto' | 'manual', onlyZones?: string[]): Promise<void> {
    const sit = this.getSituation(true);
    if (!sit) {
      this.status.textContent = 'Start a fire first.';
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.lastGen = performance.now();
    this.genBtn.disabled = true;
    const lang = this.langSel.value as Lang;
    const zones = onlyZones ? sit.zones.filter((z) => onlyZones.includes(z.id)) : sit.zones;
    this.status.textContent = reason === 'auto' ? `⚡ Escalation in Zone ${onlyZones!.join(', ')}. Writing alerts…` : 'Writing alerts…';
    try {
      // Speak first: the spoken script needs only town, tier and arrival time, so audio starts streaming
      // immediately while the AI writes the SMS text in parallel.
      const spoke = await this.speakNow(zones, lang);
      const { alerts, note } = await writeAlerts(zones, sit.ctx, lang);
      if (!alerts.length) {
        this.updateStatusLine(note);
        return;
      }
      for (const a of alerts) {
        this.alerts.set(a.zoneId, a);
        const prev = this.issued.get(a.zoneId);
        if (prev === undefined || rank(a.tier) < rank(prev)) this.issued.set(a.zoneId, a.tier);
      }
      this.render();
      const entries = alerts.map<Dispatch>((a) => ({
        simTime: sit.simTime,
        wall: sit.wallTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        zoneId: a.zoneId,
        tier: a.tier,
        reason,
        channels: { 'in-app': '✓' },
      }));
      this.log.unshift(...entries);
      this.renderLog();
      this.updateStatusLine(note);
      await this.dispatch(alerts, entries, lang, spoke);
    } finally {
      this.busy = false;
      this.genBtn.disabled = false;
    }
  }

  /** Start the spoken alerts for urgent zones right away. Returns true if audio was started. */
  private async speakNow(zones: ZoneSituation[], lang: Lang): Promise<boolean> {
    if (!this.audioChk.checked || !(await checkTts())) return false;
    const urls: string[] = [];
    const tiered = assignTiers(zones);
    for (const tier of ['EVACUATION ORDER', 'EVACUATION WARNING'] as Tier[]) {
      for (const t of tiered.filter((x) => x.tier === tier)) {
        for (const l of lang === 'en' ? (['en'] as const) : (['en', 'es'] as const)) {
          const url = clipUrl(t.zone.id, t.tier, t.etaMin, l);
          this.audio.set(`${t.zone.id}|${l}`, url);
          urls.push(url);
        }
      }
    }
    if (urls.length && !isMuted()) playClips(urls, false); // queue after anything already playing
    return urls.length > 0;
  }

  private async dispatch(alerts: Alert[], entries: Dispatch[], lang: Lang, spoke: boolean): Promise<void> {
    const byZone = new Map(entries.map((e) => [e.zoneId, e]));
    // Desktop notifications
    if (this.notifyChk.checked && 'Notification' in window && Notification.permission === 'granted') {
      for (const a of alerts) {
        try {
          new Notification(`${a.tier} · Zone ${a.zoneId} ${a.zoneName}`, { body: a.smsEn, tag: `zone-${a.zoneId}`, requireInteraction: a.tier === 'EVACUATION ORDER' });
          byZone.get(a.zoneId)!.channels.desktop = '✓';
        } catch {
          byZone.get(a.zoneId)!.channels.desktop = '✗';
        }
      }
    }
    // Webhook (server-side; prefixed [SIMULATION]) runs in the background while audio is set up
    const hook = this.webhook ? this.sendWebhook(alerts, entries, byZone) : Promise.resolve();
    // Audio: streaming URLs for every card (already speaking if speakNow started it)
    const got = (await checkTts()) && this.prepareAudio(alerts, lang);
    for (const a of alerts) {
      const e = byZone.get(a.zoneId)!;
      if (!got) e.channels.audio = 'n/a';
      else if (this.audioChk.checked && a.tier !== 'MONITOR') e.channels.audio = isMuted() ? 'muted' : '▶';
      else e.channels.audio = 'ready';
    }
    this.renderLog();
    if (got && this.audioChk.checked && !spoke) this.broadcast(alerts, true);
    await hook;
    this.renderLog();
  }

  private async sendWebhook(alerts: Alert[], entries: Dispatch[], byZone: Map<string, Dispatch>): Promise<void> {
    if (this.webhook) {
      try {
        const r = await fetch('/api/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alerts: alerts.map((a) => ({ zone: a.zoneId, name: a.zoneName, tier: a.tier, etaMin: a.etaMin, sms: a.smsEn, smsEs: a.smsEs })) }),
          signal: AbortSignal.timeout(15000),
        });
        const j = await r.json();
        for (const res of j.results ?? []) byZone.get(res.zone)!.channels[this.webhook] = res.ok ? '✓' : `✗ ${res.status ?? ''}`;
      } catch {
        for (const e of entries) e.channels[this.webhook] = '✗';
      }
    }
  }

  /** Register streaming clip URLs for every card (warms the server cache for MONITOR / replays). */
  private prepareAudio(alerts: Alert[], lang: Lang): boolean {
    let any = false;
    for (const a of alerts) {
      for (const l of lang === 'en' ? (['en'] as const) : (['en', 'es'] as const)) {
        if (l === 'es' && !a.smsEs) continue;
        const key = `${a.zoneId}|${l}`;
        if (!this.audio.has(key)) this.audio.set(key, prefetch(a.zoneId, a.tier, a.etaMin, l));
        const btn = this.list.querySelector(`button[data-play="${key}"]`) as HTMLButtonElement | null;
        if (btn) btn.hidden = false;
        any = true;
      }
    }
    if (any) this.castBtn.hidden = false;
    return any;
  }

  /** Play EVACUATION ORDER first, then EVACUATION WARNING. append=true queues after current audio. */
  private broadcast(alerts: Alert[], append = false): void {
    const urls: string[] = [];
    for (const tier of ['EVACUATION ORDER', 'EVACUATION WARNING'] as Tier[]) {
      for (const a of alerts.filter((x) => x.tier === tier)) {
        for (const l of ['en', 'es']) {
          const u = this.audio.get(`${a.zoneId}|${l}`);
          if (u) urls.push(u);
        }
      }
    }
    if (urls.length) playClips(urls, !append);
  }

  private refreshAges(sit: Situation): void {
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-issued]')) {
      el.textContent = `issued ${fmtDuration(sit.simTime - Number(el.dataset.issued))} ago`;
    }
  }

  private render(): void {
    const sit = this.getSituation(false);
    const now = sit?.simTime ?? 0;
    const alerts = [...this.alerts.values()].sort((a, b) => rank(a.tier) - rank(b.tier) || a.etaMin - b.etaMin);
    this.castBtn.hidden = !alerts.some((a) => this.audio.has(`${a.zoneId}|en`));
    this.list.innerHTML = alerts
      .map((a) => {
        const issuedAt = this.log.find((d) => d.zoneId === a.zoneId)?.simTime ?? now;
        const has = (l: string) => (this.audio.has(`${a.zoneId}|${l}`) ? '' : 'hidden');
        return `
      <article class="alert ${TIER_CLASS[a.tier]}">
        <header>
          <span class="tier">${a.tier}</span>
          <span class="zone">Zone ${a.zoneId} · ${esc(a.zoneName)}</span>
          <span class="plays">
            <button data-play="${a.zoneId}|en" ${has('en')} title="Play English audio">▶ EN</button>
            ${a.smsEs ? `<button data-play="${a.zoneId}|es" ${has('es')} title="Reproducir audio en español">▶ ES</button>` : ''}
          </span>
        </header>
        <div class="eta">Fire arrival: ${esc(a.etaText)} · <span data-issued="${issuedAt}"></span></div>
        <p class="sms">${esc(a.smsEn)} <span class="muted">(${a.smsEn.length}/160)</span></p>
        <details><summary>Full message · <span class="${a.source === 'ai' ? 'ok' : 'muted'}">${esc(a.checkNote ?? (a.source === 'template' ? 'template' : 'AI'))}</span></summary><p>${esc(a.longEn)}</p></details>
        ${
          a.smsEs
            ? `<p class="sms es">${esc(a.smsEs)} <span class="muted">(${a.smsEs.length}/160)</span></p>
               <details><summary>Mensaje completo</summary><p>${esc(a.longEs ?? '')}</p></details>`
            : ''
        }
      </article>`;
      })
      .join('');
    if (sit) this.refreshAges(sit);
  }

  private renderLog(): void {
    if (!this.log.length) {
      this.logEl.textContent = 'Nothing sent yet.';
      return;
    }
    this.logEl.innerHTML = this.log
      .slice(0, 30)
      .map(
        (d) =>
          `<div class="log-row ${TIER_CLASS[d.tier]}"><span>T+${fmtDuration(d.simTime)} (${d.wall})</span> <b>Zone ${d.zoneId}</b> ${d.tier} <span class="muted">${d.reason}</span> · ${Object.entries(
            d.channels,
          )
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}</div>`,
      )
      .join('');
  }
}
