// Spoken alert script: fixed wording written for listening (not the AI SMS text).
// Shared by the browser (audio.ts) and the server (ntfy attachment). Pure, no imports.

export type SpeechTier = 'EVACUATION ORDER' | 'EVACUATION WARNING' | 'MONITOR';

function durationEn(min: number): string {
  if (min < 60) {
    const m = Math.max(5, Math.round(min / 5) * 5);
    return `about ${m} minutes`;
  }
  const h = Math.round(min / 30) / 2; // nearest half hour
  if (h === 1) return 'about an hour';
  if (h === 1.5) return 'about an hour and a half';
  return Number.isInteger(h) ? `about ${h} hours` : `about ${Math.floor(h)} and a half hours`;
}

function durationEs(min: number): string {
  if (min < 60) {
    const m = Math.max(5, Math.round(min / 5) * 5);
    return `unos ${m} minutos`;
  }
  const h = Math.round(min / 30) / 2;
  if (h === 1) return 'una hora';
  if (h === 1.5) return 'una hora y media';
  return Number.isInteger(h) ? `unas ${h} horas` : `unas ${Math.floor(h)} horas y media`;
}

export function speechScript(town: string, tier: SpeechTier, etaMin: number, lang: 'en' | 'es'): string {
  const near = etaMin <= 5;
  if (lang === 'es') {
    const when = near ? 'El fuego está en el área o muy cerca.' : `El fuego podría llegar en ${durationEs(etaMin)}.`;
    const action =
      tier === 'EVACUATION ORDER'
        ? 'Salga ahora y siga las rutas oficiales de evacuación.'
        : tier === 'EVACUATION WARNING'
          ? 'Prepárese para salir. Tenga listos sus documentos, medicinas y mascotas.'
          : 'Manténgase atento a nuevos avisos.';
    const intro = tier === 'EVACUATION ORDER' ? 'una orden de evacuación' : tier === 'EVACUATION WARNING' ? 'una advertencia de evacuación' : 'un aviso de incendio';
    return `Esta es ${intro} para ${town}. ${when} ${action}`;
  }
  const when = near ? 'Fire is in or next to the area.' : `Fire could reach the area in ${durationEn(etaMin)}.`;
  const action =
    tier === 'EVACUATION ORDER'
      ? 'Leave now and follow official evacuation routes.'
      : tier === 'EVACUATION WARNING'
        ? 'Get ready to leave. Have your documents, medications, and pets ready to go.'
        : 'Stay alert for further updates.';
  const intro = tier === 'EVACUATION ORDER' ? 'an evacuation order' : tier === 'EVACUATION WARNING' ? 'an evacuation warning' : 'a fire advisory';
  return `This is ${intro} for ${town}. ${when} ${action}`;
}
