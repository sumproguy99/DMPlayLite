// Weather (Open-Meteo) and US severe-weather alerts (NWS): triggers, "only if it's raining / below 40°F" conditions.
import { Weather, conditionIs, readingMatches, severityAtLeast, CONDITIONS, READINGS, SEVERITIES } from '../integrations/weather.js';
import { readJson } from '../http-utils.js';
import { contains } from '../util.js';

const num = (v) => v !== '' && v != null && Number.isFinite(Number(v));
const hasWeather = (w) => Boolean(w && (w.condition || (w.reading && (num(w.above) || num(w.below)))));

export default {
  id: 'weather',
  name: 'Weather',
  config: { enabled: true, units: 'f', alerts: true },
  create: ({ getConfig, log }) => new Weather(getConfig, log),
  emits: (weather) => [weather],

  trigger: {
    source: 'weather',
    events: ['condition', 'reading', 'alert', 'alert.ended'],
    // the sky turning to rain/snow/…, a reading crossing a level, or an NWS alert (name contains, minimum severity)
    match(t, e, { ignoreChange = false } = {}) {
      if (e.type === 'condition') return !t.to || (conditionIs(e.to, t.to) && (ignoreChange || !conditionIs(e.from, t.to)));
      if (e.type === 'reading') return (t.reading || 'temperature') === e.reading && readingMatches(t, e.value, e.prev, { crossing: !ignoreChange });
      return (!t.alert || contains(e.alert, t.alert)) && severityAtLeast(e.severity, t.severity);
    },
    canHold: (t) => !t.event.startsWith('alert'),
    subject: (e) => e.reading ?? '',
    validate(t) {
      if (t.event === 'condition' && t.to && !CONDITIONS.includes(t.to)) throw new Error(`weather "to" must be one of: ${CONDITIONS.join(', ')}`);
      if (t.event === 'reading') {
        t.reading ||= 'temperature';
        if (!READINGS.includes(t.reading)) throw new Error(`weather reading must be one of: ${READINGS.join(', ')}`);
        for (const k of ['above', 'below']) {
          if (num(t[k])) t[k] = Number(t[k]);
          else delete t[k];
        }
        if (t.above == null && t.below == null) throw new Error('weather reading trigger needs "below" or "above"');
      }
      if (t.severity && !SEVERITIES.includes(t.severity)) throw new Error(`alert severity must be one of: ${SEVERITIES.join(', ')}`);
    },
    describe: (e) => (e.type === 'reading' ? `${e.reading} ${e.value}` : e.type === 'condition' ? `${e.from} → ${e.to}` : `${e.alert}${e.headline ? ` — ${e.headline}` : ''}`),
  },

  // conditions.weather: { condition: "rain" (or a list) } or { reading, above | below }
  condition: {
    has: (c) => hasWeather(c.weather),
    check(c, weather) {
      const now = weather?.current;
      if (!now) return 'no weather yet (set your location)';
      const w = c.weather;
      if (w.condition && ![w.condition].flat().some((x) => conditionIs(now.condition, x))) return `weather is ${now.condition}`;
      if (w.reading && (num(w.above) || num(w.below)) && !readingMatches(w, now[w.reading], null, { crossing: false })) return `${w.reading} is ${now[w.reading]}`;
      return null;
    },
    validate(c) {
      const w = c.weather;
      if (!w) return;
      if (w.condition && ![w.condition].flat().every((x) => CONDITIONS.includes(x))) throw new Error(`weather condition must be one of: ${CONDITIONS.join(', ')}`);
      if (w.reading && !READINGS.includes(w.reading)) throw new Error(`weather reading must be one of: ${READINGS.join(', ')}`);
    },
  },

  guide: {
    triggers: `- weather (uses the location from Connections; checked every 10 min) →
  condition: the sky changes; "to": clear|cloudy|fog|rain|snow|storm (rain includes storms). Rain starts: {"source":"weather","event":"condition","to":"rain"}
  reading: "reading": temperature|feelsLike|humidity|wind|gusts with "below" and/or "above" — fires when it CROSSES that level
    (units from Connections, °F/mph by default). Frost: {"source":"weather","event":"reading","reading":"temperature","below":32}
  alert | alert.ended: a US National Weather Service alert for this location starts/ends (checked every 2 min). Filters: "alert" (name contains,
    e.g. "Tornado Warning", "Severe Thunderstorm"), "severity" (minimum: Minor|Moderate|Severe|Extreme).
    Templates: {{alert}}, {{headline}}, {{severity}}, {{instruction}}, {{area}}. Tornado warning → lights red + urgent push:
    trigger {"source":"weather","event":"alert","alert":"Tornado Warning"}, steps set color #ff0000 + notify priority 5 "{{headline}}".`,
    conditions: 'weather {"condition": "rain"} (or a list) · weather {"reading": "temperature", "below": 40} (or "above") — the latest weather, see get_weather',
  },

  tools: (weather) => [
    {
      name: 'get_weather',
      description: 'Current weather at the home location (temperature, feels like, humidity, wind, condition, today\'s high/low) and any active US National Weather Service alerts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        if (!weather) throw new Error('Weather is not available');
        if (!weather.current && !weather.status.lastError) await weather.pollWeather().catch(() => {});
        return weather.summary();
      },
    },
  ],

  state: (weather) => ({ weather: weather.summary() }),

  routes: (weather, { updateConfig }) => ({
    'POST /api/weather/settings': async (req) => {
      const { enabled, units, alerts } = await readJson(req);
      updateConfig((c) => {
        c.weather = { ...c.weather };
        if (enabled != null) c.weather.enabled = Boolean(enabled);
        if (units) c.weather.units = units === 'c' ? 'c' : 'f';
        if (alerts != null) c.weather.alerts = Boolean(alerts);
      });
      weather.restart();
      return { ok: true };
    },
  }),
};
