// Cameras through Frigate NVR: "a person / car / package is seen" triggers, and camera pictures for phone alerts.
import { Frigate } from '../integrations/frigate.js';
import { HttpError, readJson } from '../http-utils.js';
import { contains, sameValue } from '../util.js';

export default {
  id: 'frigate',
  name: 'Frigate cameras',
  config: { url: '', username: '', password: '', topicPrefix: 'frigate' },
  create: ({ getConfig, services, log }) => new Frigate(getConfig, services.mqtt, log), // detections arrive over MQTT
  emits: (frigate) => [frigate],

  trigger: {
    source: 'camera',
    events: ['object', 'object.end'],
    // Without a zone filter only the first sighting counts (not every later zone it walks into).
    match(t, e) {
      if (t.camera && !contains(e.camera, t.camera)) return false;
      if (t.label && ![t.label].flat().some((l) => sameValue(e.label, l) || (e.subLabel && contains(e.subLabel, l)))) return false;
      if (t.minScore && e.score < Number(t.minScore)) return false;
      if (!t.zone) return e.type === 'object.end' || !e.zone;
      return e.zone ? contains(e.zone, t.zone) : (e.zones ?? []).some((z) => contains(z, t.zone));
    },
    validate(t) {
      if (t.minScore != null && t.minScore !== '' && !(Number(t.minScore) >= 0 && Number(t.minScore) <= 100)) throw new Error('minScore must be 0-100');
    },
    describe: (e) => `${e.subLabel ? `${e.subLabel} (${e.label})` : e.label} on ${e.camera}${e.zone ? ` → ${e.zone}` : ''} ${e.score}%`,
  },

  // Pictures for phone alerts ("snapshot" on a notify step): the detection, a camera's live frame, or any snapshot URL.
  snapshot: (frigate, spec, event) => frigate.snapshot(spec, event),

  guide: {
    triggers: `- camera (Frigate NVR, see list_cameras) → object (Frigate confirmed a person/car/dog/cat/package… — once per sighting, and again when it
  walks into a new zone) | object.end (it left / the event ended). Filters: "camera" (name contains), "label" ("person", "car", or a name
  Frigate recognised, e.g. a face), "zone" (only when it is in / enters that zone, e.g. "porch"), "minScore" (0-100 confidence).
  Person at the front door after dark: trigger {"source":"camera","event":"object","camera":"front","label":"person","zone":"porch"},
  conditions {"dark":true}. Templates: {{camera}}, {{label}}, {{subLabel}}, {{zone}}, {{score}}.`,
  },

  tools: (frigate, { getConfig }) => [
    {
      name: 'list_cameras',
      description: 'Frigate cameras with their zones (for camera triggers and snapshots) and the most recent detections (who/what was seen where).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        if (!frigate || !getConfig().frigate?.url) throw new Error('Frigate is not set up — add it under Connections → Cameras');
        return { status: frigate.status, cameras: frigate.cameras, recent: frigate.recent };
      },
    },
    {
      name: 'camera_snapshot',
      description: 'Look at a Frigate camera right now: returns its current picture (to check the driveway, the garage door, a package on the porch…).',
      inputSchema: { type: 'object', properties: { camera: { type: 'string', description: 'camera name from list_cameras' } }, required: ['camera'], additionalProperties: false },
      run: async (a) => {
        if (!frigate) throw new Error('Frigate is not set up');
        const shot = await frigate.snapshot(a.camera);
        return { camera: a.camera, at: new Date().toISOString(), image: { data: shot.data.toString('base64'), mimeType: 'image/jpeg' } };
      },
    },
  ],

  state: (frigate, { config: c }) => ({
    frigate: { url: c.frigate?.url ?? '', username: c.frigate?.username ?? '', hasPassword: Boolean(c.frigate?.password), topicPrefix: c.frigate?.topicPrefix || 'frigate', status: frigate.status, cameras: frigate.cameras, recent: frigate.recent },
  }),

  routes: (frigate, { getConfig, updateConfig }) => ({
    'POST /api/frigate/settings': async (req) => {
      const body = await readJson(req);
      const url = String(body.url ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+$/.test(url)) throw new HttpError(400, 'Frigate address must look like http://192.168.1.20:5000');
      const next = { ...getConfig().frigate, url, username: String(body.username ?? '').trim(), topicPrefix: String(body.topicPrefix ?? '').trim() || 'frigate' };
      if (body.password != null && body.password !== '') next.password = body.password;
      if (!next.username) next.password = '';
      let found = null;
      if (url) {
        try {
          found = await frigate.load(next);
        } catch (err) {
          throw new HttpError(400, `Couldn't connect: ${err.message}`);
        }
      }
      updateConfig((c) => (c.frigate = next));
      await frigate.restart();
      return { ok: true, ...found };
    },
  }),

  // signed-in routes that answer with something other than JSON
  raw: {
    // live camera picture for the Connections card
    '/api/frigate/snapshot': async (req, res, url, { service: frigate }) => {
      const image = await frigate.snapshot(url.searchParams.get('camera') ?? '');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      res.end(image.data);
    },
  },
};
