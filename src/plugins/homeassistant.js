// Home Assistant, two-way: any entity change is a trigger, any service is a step, HA lights become Playlite lights.
import { HomeAssistant } from '../integrations/homeassistant.js';
import { HttpError, readJson } from '../http-utils.js';
import { template } from '../util.js';

export default {
  id: 'homeassistant',
  name: 'Home Assistant',
  config: { url: '', token: '' },
  create: ({ getConfig, log }) => new HomeAssistant(getConfig, log),
  emits: (ha) => [ha],
  lights: { prefix: 'ha', driver: (ha) => ha },

  trigger: {
    source: 'homeassistant',
    events: ['state'],
    canHold: () => true,
    describe: (e) => `${e.entity}: ${e.from} → ${e.to}`,
  },

  steps: {
    ha: {
      label: (step) => `Home Assistant ${step.service}`,
      validate(s) {
        if (!/^\w+\.\w+$/.test(s.service ?? '')) throw new Error('ha step needs a service like "light.turn_on"');
      },
      async run(step, event, { service: ha, log }) {
        if (!ha) throw new Error('Home Assistant is not set up');
        await ha.callService(step.service, template(step.data ?? {}, event));
        log.info(`Home Assistant: ${step.service}`);
      },
    },
  },

  guide: {
    triggers: '- homeassistant → state. Filters: entity (entity_id or name contains), to (new state, e.g. "on", "open", "home"), from.',
    steps: '- {"type":"ha","service":"switch.turn_on","data":{"entity_id":"switch.fan"}}',
  },

  tools: (ha) => [
    {
      name: 'home_assistant_entities',
      description: 'Search Home Assistant entities (needs the Home Assistant connection). Optional domain like "light", "switch", "sensor", "climate", "lock", "person".',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string' } }, additionalProperties: false },
      run: async (a) => (ha?.status.connected ? ha.entities(a.query ?? '', a.domain ?? '').slice(0, 100) : { error: 'Home Assistant is not connected' }),
    },
    {
      name: 'home_assistant_call',
      description: 'Call any Home Assistant service, e.g. service "climate.set_temperature" with data {"entity_id":"climate.house","temperature":70}.',
      inputSchema: { type: 'object', properties: { service: { type: 'string' }, data: { type: 'object' } }, required: ['service'], additionalProperties: false },
      run: async (a) => {
        if (!ha) throw new Error('Home Assistant is not set up');
        await ha.callService(a.service, a.data ?? {});
        return { ok: true };
      },
    },
  ],

  state: (ha, { config: c, discovery }) => ({
    homeassistant: {
      url: c.homeassistant.url,
      hasToken: Boolean(c.homeassistant.token),
      status: ha.status,
      candidates: discovery.list().filter((d) => d.kind === 'home-assistant').map((d) => d.txt?.internal_url || d.txt?.base_url || `http://${d.ip}:8123`),
    },
  }),

  routes: (ha, { getConfig, updateConfig, services }) => ({
    'POST /api/ha/settings': async (req) => {
      const { url: haUrl, token } = await readJson(req);
      const u = (haUrl ?? '').replace(/\/+$/, '');
      const t = token || getConfig().homeassistant.token;
      if (!u || !t) throw new HttpError(400, 'Home Assistant URL and access token are required');
      const info = await ha.test(u, t).catch((err) => {
        throw new HttpError(400, `Couldn't connect: ${err.message.replace(/ -> /, ' → ')}`);
      });
      updateConfig((c) => {
        c.homeassistant = { url: u, token: t };
        // HA knows where home is: use it if no location was set yet
        if (!c.location?.lat && info.latitude) c.location = { lat: info.latitude, lon: info.longitude, name: info.location };
      });
      if (!services.weather?.current) services.weather?.restart();
      ha.restart();
      return { ok: true, info };
    },
    'GET /api/ha/entities': (req, url) => ha.entities(url.searchParams.get('q') ?? '', url.searchParams.get('domain') ?? '').slice(0, 300),
  }),
};
