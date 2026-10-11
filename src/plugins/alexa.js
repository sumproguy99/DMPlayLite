// Alexa: a local emulated Hue bridge, so "Alexa, discover devices" finds Playlite groups and voice-named workflows.
import { AlexaBridge } from '../integrations/alexa.js';
import { readJson } from '../http-utils.js';

export default {
  id: 'alexa',
  name: 'Alexa',
  config: { enabled: true, port: 80, ids: {}, hidden: [] },
  late: true, // needs the engine and the lights, so it's created after them
  create: ({ getConfig, updateConfig, engine, lights, log }) => new AlexaBridge({ getConfig, updateConfig, engine, lights, log }),
  start: (alexa) => alexa.start(),

  state: (alexa, { config: c }) => ({
    alexa: { enabled: c.alexa.enabled !== false, port: c.alexa.port ?? 80, status: alexa.status, items: alexa.items().map(({ id, key, name, kind }) => ({ id, key, name, kind })), hidden: c.alexa.hidden ?? [] },
  }),

  routes: (alexa, { updateConfig }) => ({
    'POST /api/alexa/settings': async (req) => {
      const body = await readJson(req);
      updateConfig((c) => (c.alexa = { ...c.alexa, ...('enabled' in body ? { enabled: body.enabled } : {}), ...(body.port ? { port: +body.port } : {}), ...(body.hidden ? { hidden: body.hidden } : {}) }));
      alexa.stop();
      alexa.start();
      return { ok: true };
    },
  }),
};
