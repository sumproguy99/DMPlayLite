// People: who's home, from Wi-Fi, OwnTracks, Home Assistant and iPhone Shortcuts. Arrive / leave / house-empty triggers
// and "only if someone / Sam is home" conditions.
import { Presence } from '../presence.js';
import { HttpError, readBody, readJson, send } from '../http-utils.js';
import { contains, randomId } from '../util.js';

export default {
  id: 'presence',
  name: 'People',
  configKey: 'people', // stored as a list at config.people
  config: [],
  create: ({ getConfig, updateConfig, discovery, services, log }) => new Presence({ getConfig, updateConfig, discovery, mqtt: services.mqtt, ha: services.homeassistant, log }),
  emits: (presence) => [presence],

  trigger: {
    source: 'presence',
    events: ['person.arrives', 'person.leaves', 'house.occupied', 'house.empty'],
    match: (t, e) => !t.person || !e.type.startsWith('person.') || contains(e.person, t.person),
    canHold: () => true,
    subject: (e) => (e.type.startsWith('person.') ? e.person : ''),
    describe: (e) => `${e.person} (${e.by})`,
  },

  // conditions.presence: { person | device, state }. A person (or anyone / everyone / nobody) first, else a network device by name.
  condition: {
    has: (c) => Boolean(c.presence?.device || c.presence?.person),
    check(c, presence, engine) {
      const who = c.presence.person || c.presence.device;
      const why = presence?.check(who, c.presence.state ?? 'home');
      if (why !== undefined) return why;
      if (!engine.discovery) return null;
      const home = engine.discovery.find(who).some((d) => d.online);
      if (c.presence.state === 'home' && !home) return `${who} is away`;
      if (c.presence.state === 'away' && home) return `${who} is home`;
      return null;
    },
  },

  guide: {
    triggers: `- presence (people, see list_people — tracked by phone on Wi-Fi, OwnTracks GPS, Home Assistant or Shortcuts) →
  person.arrives | person.leaves (filter "person": name; leave it out for anyone) | house.occupied (first person home) |
  house.empty (last person left). Everyone gone → away mode: {"source":"presence","event":"house.empty"} + step {"type":"mode","mode":"away"}.
  Prefer these over network device.online/offline for people. Templates: {{person}}, {{by}}.
  Conditions are checked AFTER the change, so "only if nobody was home" is house.occupied, not a "nobody" condition.`,
    conditions: 'presence {"person": "Dustin" | "anyone" | "everyone" | "nobody", "state": "home"|"away"} (a network "device" name also works)',
  },

  tools: (presence) => [
    {
      name: 'list_people',
      description: 'Who is home: each person with home/away, since when and what said so (Wi-Fi, OwnTracks, Home Assistant, Shortcut, manual).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => (presence?.summary() ?? []).map(({ name, state, since, by, devices, owntracks, ha }) => ({ name, state, since, by, trackedBy: [devices?.length && 'Wi-Fi', owntracks && 'OwnTracks', ha && 'Home Assistant'].filter(Boolean) })),
    },
    {
      name: 'set_presence',
      description: 'Mark a person home or away by hand (e.g. "I\'m leaving", "Sam is home"). Runs any arrives/leaves workflows.',
      inputSchema: { type: 'object', properties: { person: { type: 'string' }, state: { type: 'string', enum: ['home', 'away'] } }, required: ['person', 'state'], additionalProperties: false },
      run: async (a) => {
        if (!presence) throw new Error('Presence is not available');
        return { ok: true, changed: presence.set(a.person, a.state, 'AI') };
      },
    },
  ],

  state: (presence) => ({ people: presence.summary() }),

  routes: (presence, { getConfig, updateConfig }) => ({
    'PUT /api/people': async (req) => {
      const list = await readJson(req);
      if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of people');
      const old = getConfig().people ?? [];
      const ids = new Set();
      const people = list.map((p) => {
        const name = String(p.name ?? '').trim();
        if (!name) throw new HttpError(400, 'Every person needs a name');
        if (/^(anyone|everyone|someone|nobody)$/i.test(name)) throw new HttpError(400, `"${name}" is reserved — pick another name`);
        let id = p.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomId(3);
        while (ids.has(id)) id += '-2';
        ids.add(id);
        const prev = old.find((x) => x.id === id) ?? {};
        const clean = (v) => String(v ?? '').trim();
        return {
          id,
          name,
          devices: [p.devices ?? []].flat().map(clean).filter(Boolean),
          owntracks: clean(p.owntracks),
          ha: clean(p.ha),
          ...(clean(p.region) ? { region: clean(p.region) } : {}),
          ...(Number(p.radius) > 0 ? { radius: Number(p.radius) } : {}),
          shortcuts: Boolean(p.shortcuts ?? prev.shortcuts),
          state: prev.state ?? 'away',
          since: prev.since ?? null,
          by: prev.by ?? null,
        };
      });
      updateConfig((c) => (c.people = people));
      presence.reconcile();
      return { ok: true, people };
    },
    'POST /api/people/state': async (req, url, user) => {
      const { person, state } = await readJson(req);
      try {
        presence.set(person, state, `${user} (manual)`);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return { ok: true };
    },
  }),

  keyed: {
    prefixes: ['/presence/'],
    async handle(req, res, url, { service: presence }) {
      const p = url.pathname;
      if (p === '/presence/owntracks') {
        // OwnTracks HTTP mode: URL …/presence/owntracks?key=…&person=Name; it expects a JSON list back
        const msg = JSON.parse((await readBody(req)) || 'null');
        try {
          presence.owntracks(url.searchParams.get('person') ?? req.headers['x-limit-u'] ?? '', msg);
        } catch (err) {
          return send(res, 404, { error: err.message });
        }
        return send(res, 200, []);
      }
      // iOS Shortcuts automation "When I arrive / leave home" → GET /presence/<person>/home|away
      const [, , who, state] = p.split('/').map(decodeURIComponent);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try {
        const person = presence.webhook(who, String(state).toLowerCase());
        return res.writeHead(200).end(`${person.name} is ${state}`);
      } catch (err) {
        return res.writeHead(400).end(err.message);
      }
    },
  },
};
