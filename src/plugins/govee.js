// Govee LAN lights (software fades), found by multicast scan or added by IP.
import { GoveeDriver } from '../integrations/govee.js';
import { HttpError, readJson } from '../http-utils.js';
import { lanAddresses } from '../net.js';

export default {
  id: 'govee',
  name: 'Govee',
  config: { devices: {}, multicastInterface: '' },
  create({ getConfig, saveConfig, log }) {
    const govee = new GoveeDriver(getConfig, saveConfig, log);
    govee.defaultInterface = lanAddresses()[0]; // multicast on the home LAN, not a VPN adapter
    return govee;
  },
  start: (govee) => govee.start(),
  lights: { prefix: 'govee', driver: (govee) => govee },

  state: (govee, { config: c }) => ({ govee: { multicastInterface: c.govee.multicastInterface, devices: govee.list() } }),

  routes: (govee, { updateConfig }) => ({
    'POST /api/govee/scan': async () => ({ found: await govee.scan(), devices: govee.list() }),
    'POST /api/govee/add': async (req) => {
      const { ip } = await readJson(req);
      await govee.addByIp(ip);
      return { devices: govee.list() };
    },
    'POST /api/govee/rename': async (req) => {
      const { id, name } = await readJson(req);
      updateConfig((c) => {
        if (!c.govee.devices[id]) throw new HttpError(404, 'No such device');
        c.govee.devices[id].name = name;
      });
      return { devices: govee.list() };
    },
    'POST /api/govee/remove': async (req) => {
      const { id } = await readJson(req);
      updateConfig((c) => delete c.govee.devices[id]);
      return { devices: govee.list() };
    },
    'POST /api/govee/settings': async (req) => {
      const { multicastInterface } = await readJson(req);
      updateConfig((c) => (c.govee.multicastInterface = multicastInterface ?? ''));
      govee.stop();
      govee.start();
      return { ok: true };
    },
  }),
};
