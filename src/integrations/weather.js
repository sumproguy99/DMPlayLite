// Weather from Open-Meteo (worldwide, no account or key) and severe-weather alerts from the US National Weather Service
// (api.weather.gov, no key; US only). Both use the location set under Connections → Location, rounded before it leaves the PC
// (~1 km for the weather, ~100 m for alerts so the right county/zone is used). weather.enabled = false turns both off.
//   -> engine events { source:'weather', type:'condition', from, to }                 when the sky changes (clear → rain…)
//                    { source:'weather', type:'reading', reading, value, prev }        every poll (chatty), for "temperature drops below 32"
//                    { source:'weather', type:'alert' | 'alert.ended', alert, severity, headline, … }
import { EventEmitter } from 'node:events';

export const CONDITIONS = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
export const READINGS = ['temperature', 'feelsLike', 'humidity', 'wind', 'gusts'];
export const SEVERITIES = ['Minor', 'Moderate', 'Severe', 'Extreme'];
const WEATHER_EVERY = 10 * 60_000;
const ALERTS_EVERY = 2 * 60_000;
const USER_AGENT = 'Playlite home automation (https://github.com/sumproguy99/DMPlayLite)';

// WMO weather code -> one of CONDITIONS
export function conditionOf(code) {
  if (code <= 1) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'rain'; // drizzle, rain, freezing rain, showers
}

// "rain" also covers thunderstorms — it's raining either way.
export const conditionIs = (cur, want) => cur === want || (want === 'rain' && cur === 'storm');
export const severityAtLeast = (sev, min) => !min || SEVERITIES.indexOf(sev) >= SEVERITIES.indexOf(min);

const num = (v) => v !== '' && v != null && Number.isFinite(Number(v));
// above / below a level; crossing = only when it wasn't already there
export function readingMatches({ above, below }, value, prev, { crossing = true } = {}) {
  if (!num(value) || (!num(above) && !num(below))) return false;
  const ok = (v) => num(v) && (!num(above) || v > Number(above)) && (!num(below) || v < Number(below));
  return ok(value) && (!crossing || (num(prev) && !ok(prev)));
}

export class Weather extends EventEmitter {
  status = { ok: false, lastError: null, alerts: null }; // alerts: null = fine, else why alerts aren't available
  current = null;
  alerts = []; // active NWS alerts at the location
  weatherUrl = 'https://api.open-meteo.com';
  alertsUrl = 'https://api.weather.gov';
  #weatherTimer = null;
  #alertTimer = null;
  #seen = new Set(); // alert ids already announced (including the ids they update) — kept across restarts
  #primed = false;
  #place = null; // the location the alert list is for

  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().weather ?? {}; }
  get loc() { return this.getConfig().location ?? {}; }
  get units() { return this.cfg.units === 'c' ? 'c' : 'f'; }

  restart() {
    this.stop();
    this.current = null;
    // a settings change keeps the alert list (so nothing is announced twice or "ended" by mistake); a new location starts over
    const place = `${this.loc.lat},${this.loc.lon}`;
    if (place !== this.#place) {
      this.alerts = [];
      this.#primed = false;
      this.#place = place;
    }
    if (this.cfg.enabled === false) {
      this.status = { ok: false, lastError: null, alerts: null };
      return;
    }
    if (!num(this.loc.lat) || !num(this.loc.lon)) {
      this.status = { ok: false, lastError: 'Set your location first', alerts: null };
      return;
    }
    this.status = { ok: false, lastError: null, alerts: null };
    const every = (fn, ms) => {
      const run = () => fn().catch((err) => this.log.warn(`Weather: ${err.message}`));
      run();
      const t = setInterval(run, ms);
      t.unref?.();
      return t;
    };
    this.#weatherTimer = every(() => this.pollWeather(), WEATHER_EVERY);
    if (this.cfg.alerts !== false) this.#alertTimer = every(() => this.pollAlerts(), ALERTS_EVERY);
  }

  stop() {
    clearInterval(this.#weatherTimer);
    clearInterval(this.#alertTimer);
    this.#weatherTimer = this.#alertTimer = null;
  }

  async pollWeather() {
    const { lat, lon } = this.loc;
    const q = new URLSearchParams({
      latitude: Number(lat).toFixed(2),
      longitude: Number(lon).toFixed(2),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
      daily: 'temperature_2m_max,temperature_2m_min',
      forecast_days: 1,
      temperature_unit: this.units === 'c' ? 'celsius' : 'fahrenheit',
      wind_speed_unit: this.units === 'c' ? 'kmh' : 'mph',
      timezone: 'auto',
    });
    let res;
    try {
      res = await fetch(`${this.weatherUrl}/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`weather service answered HTTP ${res.status}`);
      res = await res.json();
    } catch (err) {
      this.status.ok = false;
      this.status.lastError = err.name === 'TimeoutError' ? 'weather service did not answer' : err.message;
      throw err;
    }
    const c = res.current ?? {};
    const round = (v) => (num(v) ? Math.round(v * 10) / 10 : null);
    const cur = {
      temperature: round(c.temperature_2m),
      feelsLike: round(c.apparent_temperature),
      humidity: round(c.relative_humidity_2m),
      wind: round(c.wind_speed_10m),
      gusts: round(c.wind_gusts_10m),
      code: c.weather_code,
      condition: conditionOf(Number(c.weather_code)),
      isDay: Boolean(c.is_day),
      high: round(res.daily?.temperature_2m_max?.[0]),
      low: round(res.daily?.temperature_2m_min?.[0]),
      units: this.units,
      at: new Date().toISOString(),
    };
    const prev = this.current;
    this.current = cur;
    this.status.ok = true;
    this.status.lastError = null;
    if (!prev || prev.units !== cur.units) return cur; // first reading: nothing "changed" yet
    const at = cur.at;
    if (prev.condition !== cur.condition) this.emit('event', { source: 'weather', type: 'condition', from: prev.condition, to: cur.condition, temperature: cur.temperature, at });
    for (const reading of READINGS) {
      if (num(cur[reading])) this.emit('event', { source: 'weather', type: 'reading', reading, value: cur[reading], prev: prev[reading], units: cur.units, chatty: true, at });
    }
    return cur;
  }

  async pollAlerts() {
    const { lat, lon } = this.loc;
    let res;
    try {
      res = await fetch(`${this.alertsUrl}/alerts/active?point=${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.status.alerts = `alert service did not answer (${err.cause?.code ?? err.name})`;
      throw err;
    }
    if (res.status === 400 || res.status === 404) {
      // NWS only covers the US: stop asking
      this.status.alerts = 'Severe-weather alerts come from the US National Weather Service and only cover the US';
      clearInterval(this.#alertTimer);
      return [];
    }
    if (!res.ok) {
      this.status.alerts = `alert service answered HTTP ${res.status}`;
      throw new Error(this.status.alerts);
    }
    const body = await res.json();
    this.status.alerts = null;
    const now = Date.now();
    const list = (body.features ?? [])
      .map((f) => f.properties ?? {})
      .filter((p) => p.id && p.messageType !== 'Cancel' && p.status !== 'Test')
      .map((p) => ({
        id: p.id,
        alert: p.event ?? 'Weather alert',
        severity: p.severity ?? 'Unknown',
        urgency: p.urgency ?? 'Unknown',
        headline: p.headline ?? p.event ?? '',
        description: String(p.description ?? '').slice(0, 1500),
        instruction: String(p.instruction ?? '').slice(0, 800),
        area: p.areaDesc ?? '',
        sent: p.sent,
        expires: p.ends ?? p.expires,
        refs: (p.references ?? []).map((r) => r.identifier ?? r['@id']).filter(Boolean),
      }));
    // ended = was active, isn't any more, and wasn't replaced by an update
    const covered = new Set(list.flatMap((a) => [a.id, ...a.refs]));
    for (const old of this.alerts) {
      if (!covered.has(old.id)) this.emit('event', this.#event('alert.ended', old));
    }
    for (const a of list) {
      const known = this.#seen.has(a.id) || a.refs.some((r) => this.#seen.has(r));
      this.#seen.add(a.id);
      // On start-up only announce alerts issued in the last 15 minutes (the rest were announced before a restart).
      if (!known && (this.#primed || now - Date.parse(a.sent) < 15 * 60_000)) this.emit('event', this.#event('alert', a));
    }
    if (this.#seen.size > 1000) this.#seen = new Set([...this.#seen].slice(-500));
    this.#primed = true;
    this.alerts = list;
    return list;
  }

  #event(type, a) {
    const { id, refs, ...rest } = a;
    return { source: 'weather', type, ...rest, at: new Date().toISOString() };
  }

  summary() {
    return {
      enabled: this.cfg.enabled !== false,
      units: this.units,
      alertsEnabled: this.cfg.alerts !== false,
      status: this.status,
      current: this.current,
      alerts: this.alerts.map(({ alert, severity, urgency, headline, expires, area }) => ({ alert, severity, urgency, headline, expires, area })),
    };
  }
}
