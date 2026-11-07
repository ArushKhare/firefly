// Top bar wiring: play/pause, speed, reset, ignite mode, weather source.
import { PLAYBACK } from '../config.ts';

export interface ControlHandlers {
  onPlayToggle(): void;
  onSpeed(s: number): void;
  onReset(): void;
  onIgniteToggle(on: boolean): void;
  onWeatherSource(src: 'live' | 'redflag' | 'hotstill' | 'santaana' | 'historical'): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Controls {
  private playBtn = $<HTMLButtonElement>('btn-play');
  private igniteBtn = $<HTMLButtonElement>('btn-ignite');
  private speedBtns: HTMLButtonElement[] = [];
  igniteOn = true;

  constructor(h: ControlHandlers) {
    const seg = $('speed');
    for (const s of PLAYBACK.SPEEDS) {
      const b = document.createElement('button');
      b.textContent = `${s}×`;
      b.title = `${s} sim-minute${s === 1 ? '' : 's'} per second`;
      b.onclick = () => {
        this.setSpeed(s);
        h.onSpeed(s);
      };
      seg.appendChild(b);
      this.speedBtns.push(b);
    }
    this.setSpeed(PLAYBACK.DEFAULT_SPEED);
    this.playBtn.onclick = () => h.onPlayToggle();
    $('btn-reset').onclick = () => h.onReset();
    this.igniteBtn.onclick = () => {
      this.igniteOn = !this.igniteOn;
      this.igniteBtn.classList.toggle('on', this.igniteOn);
      h.onIgniteToggle(this.igniteOn);
    };
    const sel = $<HTMLSelectElement>('wx-source');
    sel.onchange = () => h.onWeatherSource(sel.value as 'live' | 'redflag' | 'hotstill' | 'santaana' | 'historical');
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        h.onPlayToggle();
      }
    });
  }

  setPlaying(p: boolean): void {
    this.playBtn.textContent = p ? '❚❚ Pause' : '▶ Play';
    this.playBtn.classList.toggle('on', p);
  }

  setSpeed(s: number): void {
    PLAYBACK.SPEEDS.forEach((v, k) => this.speedBtns[k].classList.toggle('on', v === s));
  }
}
