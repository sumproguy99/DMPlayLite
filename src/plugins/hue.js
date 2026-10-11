// Philips Hue: bridge lights (native fades) plus motion sensors, dimmers/buttons and contact sensors as triggers.
import { HueDriver } from '../integrations/hue.js';
import { HueSensors } from '../integrations/huesensors.js';
import { HttpError, readJson } from '../http-utils.js';
import { fetchJson } from '../util.js';

export default {
  id: 'hue',
  name: 'Philips Hue',
  config: { bridgeIp: '', username: '' },
  create: ({ getConfig, log }) => ({ driver: new HueDriver(getConfig, log), sensors: new HueSensors(getConfig, log) }),
  start: (hue) => hue.sensors.restart(),
  stop: (hue) => hue.sensors.stop(),
  emits: (hue) => [hue.sensors],
  lights: { prefix: 'hue', driver: (hue) => hue.driver },

  trigger: {
    source: 'hue',
    events: ['motion', 'button', 'contact'],
    canHold: (t) => t.event !== 'button',
    validate(t) {
      if (t.event === 'button') t.press ||= 'short_release'; // one press = one run
    },
    describe: (e) => e.to ?? `button ${e.button ?? ''} ${e.press}`,
  },

  guide: {
    triggers: `- hue → motion (filter "to": "detected"|"clear") | contact (Hue door/window sensor, "to": "open"|"closed") |
  button (Hue dimmer/smart button/tap switch; "button": 1-4, "press": "short_release"|"long_press"|"repeat"|"long_release"|"initial_press").
  Filter "device" = sensor name contains. No motion for 10 min: {"source":"hue","event":"motion","device":"Hall","to":"clear","forMin":10}.`,
  },

  tools: (hue) => [
    {
      name: 'list_hue_sensors',
      description: 'Hue motion sensors, dimmers/buttons and contact sensors paired to the Hue bridge (names to use in "hue" triggers).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const sensors = hue?.sensors;
        if (!sensors?.status.connected) throw new Error(`Hue sensors are not connected${sensors?.status.lastError ? `: ${sensors.status.lastError}` : ''}`);
        return sensors.sensors();
      },
    },
  ],

  state: (hue, { config: c, discovery }) => ({
    hue: {
      bridgeIp: c.hue.bridgeIp,
      paired: hue.driver.ready,
      candidates: discovery.list().filter((d) => d.kind === 'hue-bridge').map((d) => d.ip),
      sensors: { ...hue.sensors.status, devices: hue.sensors.sensors() },
    },
  }),

  routes: (hue, { updateConfig, discovery, log }) => ({
    'POST /api/hue/discover': async () => {
      // Candidates from discovery (+ Philips MAC prefixes) and Philips' cloud lookup; keep only real bridges.
      const ips = new Set(discovery.list().filter((d) => d.kind === 'hue-bridge' || d.vendor === 'Philips Hue').map((d) => d.ip));
      for (const b of await hue.driver.discover().catch(() => [])) ips.add(b.ip);
      const checked = await Promise.all([...ips].map(async (ip) => {
        const cfg = await fetchJson(`http://${ip}/api/config`, { timeoutMs: 2500 }).catch(() => null);
        return cfg?.bridgeid ? { id: cfg.bridgeid, ip, name: cfg.name } : null;
      }));
      return checked.filter(Boolean);
    },
    'POST /api/hue/pair': async (req) => {
      const { ip } = await readJson(req);
      if (!ip) throw new HttpError(400, 'Bridge IP required');
      const username = await hue.driver.pair(ip);
      updateConfig((c) => (c.hue = { bridgeIp: ip, username }));
      log.info(`Hue: paired with bridge at ${ip}`);
      hue.sensors.restart();
      return { ok: true };
    },
  }),
};
