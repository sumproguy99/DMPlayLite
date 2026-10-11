// WLED LED strips (native fades): found by network discovery or added by IP.
import { WledDriver } from '../integrations/wled.js';
import { HttpError, readJson } from '../http-utils.js';

export default {
  id: 'wled',
  name: 'WLED',
  config: { devices: {} },
  create: ({ getConfig, updateConfig, log }) => new WledDriver(getConfig, updateConfig, log),
  lights: { prefix: 'wled', driver: (wled) => wled },

  state: (wled, { config: c, discovery }) => ({
    wled: {
      devices: Object.entries(c.wled.devices).map(([id, d]) => ({ id, ...d })),
      candidates: discovery.list().filter((d) => d.kind === 'wled' && !Object.values(c.wled.devices).some((w) => w.ip === d.ip)).map((d) => ({ ip: d.ip, name: d.name })),
    },
  }),

  routes: (wled) => ({
    'POST /api/wled/add': async (req) => {
      const { ip } = await readJson(req);
      try {
        return { ok: true, id: await wled.add(ip) };
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
    'POST /api/wled/rename': async (req) => {
      const { id, name } = await readJson(req);
      wled.rename(id, name);
      return { ok: true };
    },
    'POST /api/wled/remove': async (req) => {
      const { id } = await readJson(req);
      wled.remove(id);
      return { ok: true };
    },
  }),
};
