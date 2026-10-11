// Fires "time" workflows: at a clock time (optionally on certain weekdays) or at sunrise/sunset ± offset.
import { sunTimes } from './solar.js';

export function nextFireToday(trigger, now, location) {
  const day = now.getDay();
  if (trigger.days?.length && !trigger.days.includes(day)) return null;
  if (trigger.event === 'time.at') {
    const [h, m] = String(trigger.at ?? '').split(':').map(Number);
    if (Number.isNaN(h)) return null;
    const t = new Date(now);
    t.setHours(h, m || 0, 0, 0);
    return t;
  }
  if (trigger.event === 'sun.sunrise' || trigger.event === 'sun.sunset') {
    if (!location?.lat) return null;
    const sun = sunTimes(now, location.lat, location.lon);
    const base = trigger.event === 'sun.sunrise' ? sun.sunrise : sun.sunset;
    return base ? new Date(base.getTime() + (trigger.offsetMin ?? 0) * 60_000) : null;
  }
  return null;
}

export class Scheduler {
  #fired = new Set(); // `${routineId}|${yyyy-mm-dd}`
  #timer = null;

  constructor({ getConfig, engine, log }) {
    this.getConfig = getConfig;
    this.engine = engine;
    this.log = log;
  }

  #started = Date.now();

  start() {
    this.#started = Date.now();
    this.#timer = setInterval(() => this.tick(), 15_000);
    this.tick();
  }

  stop() { clearInterval(this.#timer); }

  tick(now = new Date()) {
    const dayKey = now.toLocaleDateString('en-CA');
    for (const r of this.getConfig().routines) {
      if (!r.enabled || r.trigger?.source !== 'time') continue;
      const at = nextFireToday(r.trigger, now, this.getConfig().location);
      if (!at) continue;
      const key = `${r.id}|${dayKey}`;
      // Fire once per day, within 2 minutes after the target (and never for times before we started).
      if (now >= at && now - at < 120_000 && at.getTime() >= this.#started - 1000 && !this.#fired.has(key)) {
        this.#fired.add(key);
        this.log.event(`time: ${r.trigger.event === 'time.at' ? r.trigger.at : r.trigger.event.replace('sun.', '')} → "${r.name}"`);
        this.engine.fire(r, { source: 'time', type: r.trigger.event, at: now.toISOString() });
      }
    }
    if (this.#fired.size > 500) this.#fired.clear();
  }

  // Upcoming times for the UI.
  upcoming(now = new Date()) {
    const loc = this.getConfig().location;
    const sun = loc?.lat ? sunTimes(now, loc.lat, loc.lon) : null;
    return { sunrise: sun?.sunrise ?? null, sunset: sun?.sunset ?? null };
  }
}
