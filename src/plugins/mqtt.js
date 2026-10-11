// MQTT: any broker message is a trigger (topic wildcards, whole payload or one JSON field), and the "📡 MQTT message" step.
import { Mqtt, topicMatches } from '../integrations/mqtt.js';
import { HttpError, readJson } from '../http-utils.js';
import { sameValue, template } from '../util.js';

const pathOf = (obj, path) => String(path).split('.').reduce((o, k) => o?.[k], obj);

// Topic (with + / # wildcards), then either the whole payload or one JSON field.
// A field trigger fires when that field CHANGES (Zigbee2MQTT resends every field on each update);
// ignoreChange is for "does this still hold?" checks during a "for N minutes" wait.
export function matchesMqtt(t, e, { ignoreChange = false } = {}) {
  if (!topicMatches(t.topic, e.topic)) return false;
  if (!t.field) return t.payload == null || t.payload === '' || sameValue(e.payload, t.payload);
  const now = pathOf(e.json, t.field);
  if (now === undefined) return false;
  if (t.value != null && t.value !== '' && !sameValue(now, t.value)) return false;
  if (!ignoreChange && e.prevJson !== undefined && sameValue(pathOf(e.prevJson, t.field), now)) return false;
  return true;
}

export default {
  id: 'mqtt',
  name: 'MQTT',
  config: { url: '', username: '', password: '' },
  create: ({ getConfig, log }) => new Mqtt(getConfig, log),
  emits: (mqtt) => [mqtt],

  trigger: {
    source: 'mqtt',
    events: ['message'],
    match: matchesMqtt,
    canHold: () => true,
    validate(t) {
      if (!String(t.topic ?? '').trim()) throw new Error('MQTT trigger needs a topic');
    },
    describe: (e) => `${e.topic} ${String(e.payload).slice(0, 120)}`,
  },

  steps: {
    mqtt: {
      label: (step) => `MQTT ${step.topic}`,
      validate(s) {
        if (!String(s.topic ?? '').trim() || /[+#]/.test(s.topic)) throw new Error('mqtt step needs a plain topic (no + or # wildcards)');
      },
      run(step, event, { service: mqtt, log }) {
        if (!mqtt) throw new Error('MQTT is not set up');
        const topic = template(step.topic, event);
        mqtt.publish(topic, template(step.payload ?? '', event), { retain: Boolean(step.retain) });
        log.info(`MQTT → ${topic}`);
      },
    },
  },

  guide: {
    triggers: `- mqtt → message. "topic" (MQTT wildcards + and # allowed, see mqtt_topics) and EITHER "payload" (whole message equals, e.g. "ON")
  OR "field" (JSON key, dots for nesting) with optional "value" — a field trigger fires when that field CHANGES (to "value").
  Zigbee2MQTT motion: {"source":"mqtt","event":"message","topic":"zigbee2mqtt/Hall motion","field":"occupancy","value":"true"}
  No motion for 10 min: same with "value":"false","forMin":10. Templates: {{topic}}, {{payload}}, {{json.temperature}}.`,
    steps: `- {"type":"mqtt","topic":"zigbee2mqtt/Lamp/set","payload":{"state":"ON"},"retain":false}   (publish; payload may be text or JSON, {{variables}} work)`,
  },

  tools: (mqtt) => [
    {
      name: 'mqtt_topics',
      description: 'MQTT topics seen recently on the broker, newest first, with their last message (use to find Zigbee2MQTT / Tasmota / Frigate topics and JSON fields). Optional text filter.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      run: async (a) => {
        if (!mqtt?.status.connected) throw new Error('MQTT is not connected — set it up under Connections → MQTT');
        return mqtt.recent(a.query ?? '').slice(0, 60);
      },
    },
    {
      name: 'mqtt_publish',
      description: 'Publish an MQTT message, e.g. topic "zigbee2mqtt/Lamp/set" payload {"state":"TOGGLE"}, or "cmnd/plug/POWER" payload "ON".',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' }, payload: {}, retain: { type: 'boolean' } }, required: ['topic'], additionalProperties: false },
      run: async (a) => {
        if (!mqtt) throw new Error('MQTT is not set up');
        mqtt.publish(a.topic, a.payload, { retain: a.retain });
        return { ok: true };
      },
    },
  ],

  state: (mqtt, { config: c }) => ({ mqtt: { url: c.mqtt.url, username: c.mqtt.username, hasPassword: Boolean(c.mqtt.password), status: mqtt.status, topics: mqtt.topics.size } }),

  routes: (mqtt, { getConfig, updateConfig }) => ({
    'POST /api/mqtt/settings': async (req) => {
      const body = await readJson(req);
      const next = { ...getConfig().mqtt, url: String(body.url ?? '').trim(), username: String(body.username ?? '').trim() };
      if (body.password != null && body.password !== '') next.password = body.password;
      if (body.clearPassword) next.password = '';
      if (next.url) {
        try {
          await Mqtt.test(next);
        } catch (err) {
          throw new HttpError(400, `Couldn't connect: ${err.message}`);
        }
      }
      updateConfig((c) => (c.mqtt = next));
      mqtt.restart();
      return { ok: true };
    },
    'GET /api/mqtt/topics': (req, url) => mqtt.recent(url.searchParams.get('q') ?? '').slice(0, 300),
  }),
};
