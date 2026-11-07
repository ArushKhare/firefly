# FireFly

**Predictive wildfire modeling + AI-written, voice-broadcast evacuation warnings.**
Built at NOVA (CMU GenAI hackathon). Replays the January 2025 **Palisades** and **Eaton** fires in Los Angeles with real terrain, real weather and real fire perimeters for validation.

> ⚠️ Simulation only. Every outgoing message is prefixed `[SIMULATION]`. Not an official forecast or alerting system.

## What it does
1. **Predicts fire spread.** An arrival-time solver runs in a Web Worker over a 60 m grid of LA. It models wind (empirical 10%/20% rules), fuel moisture from temperature and humidity, slope, crown fire, embers, house-to-house spread, and fire-generated weather (gusts, plume, indraft, column collapse, fire whirls).
2. **Quantifies uncertainty.** Each update runs 8 extra versions with varied wind, dryness and urban flammability, giving a likely range of arrival times for each zone.
3. **Triggers warnings predictively.** It issues an EVACUATION ORDER when the earliest plausible arrival is less than the zone's evacuation clearance time plus a buffer, and an EVACUATION WARNING further out. Tiers never downgrade on their own.
4. **Writes and announces alerts automatically.** A fast LLM writes SMS and long-form text in English and Spanish. **Deepgram Aura-2** reads a fixed spoken script, streamed so the first sound comes in under 1 s. Alerts go out in-app, as audio, and optionally as a phone push via ntfy.
5. **Simulates the firefight.** Crews build continuous control line from the heel of the fire along both flanks, aircraft are grounded in strong gusts, the fire can overrun or spot across a line, and containment is reported up to 100%.
6. **Validates against reality.** The official final perimeters are drawn on the map, and the model reports its overlap with them.

## Secure AI design
- **The AI never decides who evacuates.** Tiers come from deterministic code. The LLM only phrases them.
- **No free text reaches the model.** The browser sends structured facts (zone ID, tier, minutes, wind). The server validates them and builds the prompt from its own zone list.
- **Every draft is fact-checked** before it is shown, spoken or sent. The checker looks for the correct tier words and zone, no other tier's wording, no links or phone numbers, and confirms that every time, mph and km figure matches the facts. A draft that fails falls back to a fixed template.
- **The voice only speaks the server's own script.** `/api/tts` accepts zone, tier and ETA, never arbitrary text.
- **Keys stay server-side.** The server also rate-limits requests per IP, supports an optional site password (`APP_PASSWORD`), and disables general chat in production.

## Data
- **Elevation:** AWS Terrain Tiles (USGS 3DEP).
- **Imagery:** Esri World Imagery. Fuels are classified from colour and texture, then checked block by block by a vision model (`tools/vision_fuel.py` writes `web/public/landcover/vision_la.json`).
- **Weather:** Open-Meteo historical forecast, hourly, Jan 7–10 2025 (`web/public/weather/`).
- **Perimeters:** NIFC WFIGS interagency perimeters (`web/public/perimeters/`).

## Run locally
```bash
npm run setup                 # installs web + server deps, creates server/.env from the example
# edit server/.env: set OPENROUTER_API_KEY (one key covers the LLM and Deepgram via OpenRouter)
npm run dev                   # server on :8787, app on http://localhost:5173
```
Press **Palisades** or **Eaton** to replay a fire. Set `DEMO_MODE = false` in `web/src/config.ts` to show every control.

## Deploy (single service)
`npm run build && npm start` serves the built app and the API from one Node 22 process. Set these variables on the host: `OPENROUTER_API_KEY`, `ALERT_MODEL`, `TTS_VOICE`, `TTS_VOICE_ES`, `NODE_ENV=production`, and optionally `APP_PASSWORD`.

## Stack
Vite + TypeScript, Leaflet, Web Workers · Express (Node 22) · OpenRouter (Gemini 3.5 Flash-Lite for alerts) · Deepgram Aura-2 · Railway
