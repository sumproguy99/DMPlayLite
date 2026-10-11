// Plex: playback / player triggers (polling + optional webhooks) and the "▶️ Plex playback" step.
import { PlexIntegration, PLEX_ACTIONS } from '../integrations/plex.js';
import { HttpError, readJson, send } from '../http-utils.js';
import { randomId, template } from '../util.js';

const ACTIONS = ['toggle', ...Object.keys(PLEX_ACTIONS)];

export default {
  id: 'plex',
  name: 'Plex',
  config: { url: '', token: '', clientId: `playlite-${randomId(8)}`, pollSeconds: 10 },
  create: ({ getConfig, log }) => new PlexIntegration(getConfig, log),
  emits: (plex) => [plex],

  trigger: {
    source: 'plex',
    events: ['player.online', 'player.offline', 'media.play', 'media.pause', 'media.resume', 'media.stop', 'media.scrobble'],
    canHold: (t) => t.event !== 'media.scrobble',
  },

  steps: {
    plex: {
      label: (step) => `Plex ${step.action}`,
      validate(s) {
        if (!ACTIONS.includes(s.action)) throw new Error(`plex step action must be one of: ${ACTIONS.join(', ')}`);
      },
      async run(step, event, { service: plex, log }) {
        if (!plex) throw new Error('Plex is not set up');
        const player = template(step.player ?? '', event).trim();
        // no player named: the Plex player that triggered this workflow, else whatever is playing
        const target = player ? { player } : event.source === 'plex' ? { playerId: event.playerId, player: event.player } : {};
        const { player: name } = await plex.control(step.action ?? 'pause', target);
        log.info(`Plex: ${step.action} on ${name}`);
      },
    },
  },

  guide: {
    triggers: `- plex → player.online | player.offline | media.play | media.pause | media.resume | media.stop | media.scrobble.
  Filters: player (device name contains), user, mediaTypes ["movie","episode","clip","track"], skipContinued (ignore next-episode autoplay).`,
    steps: `- {"type":"plex","action":"pause","player":"Living Room"}   (actions: pause, play, toggle, stop, next, previous, forward, back;
  leave "player" out to control the Plex player that triggered the workflow, or else the one that's playing. E.g. doorbell → pause the movie)`,
  },

  tools: (plex) => [
    {
      name: 'plex_control',
      description: 'Control Plex playback on a player: pause, play, toggle, stop, next, previous, forward (~30 s), back (~10 s). Leave player out to control whatever is playing.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS }, player: { type: 'string' } }, required: ['action'], additionalProperties: false },
      run: async (a) => {
        if (!plex) throw new Error('Plex is not set up');
        return { ok: true, ...(await plex.control(a.action, a.player ? { player: a.player } : {})) };
      },
    },
  ],

  state: (plex, { config: c }) => ({ plex: { url: c.plex.url, hasToken: Boolean(c.plex.token), pollSeconds: c.plex.pollSeconds, status: plex.status } }),

  routes(plex, { updateConfig }) {
    let servers = []; // from the last sign-in, until one is picked
    return {
      'POST /api/plex/pin': () => plex.createPin(),
      'POST /api/plex/pin/check': async (req) => {
        const { id } = await readJson(req);
        const token = await plex.checkPin(id);
        if (!token) return { done: false };
        servers = await plex.listServers(token);
        return { done: true, servers: servers.map(({ name, connections }, i) => ({ index: i, name, connections })) };
      },
      'POST /api/plex/settings': async (req) => {
        const body = await readJson(req);
        updateConfig((c) => {
          if (body.serverIndex != null) {
            const s = servers[body.serverIndex];
            if (!s) throw new HttpError(400, 'Sign in again — server list expired');
            c.plex.token = s.token;
          }
          if (body.token) c.plex.token = body.token;
          if (body.url) c.plex.url = body.url.replace(/\/+$/, '');
          if (body.pollSeconds) c.plex.pollSeconds = Number(body.pollSeconds);
        });
        plex.restart();
        await plex.refreshSessions();
        return { ok: true, status: plex.status };
      },
    };
  },

  // Plex Pass webhooks: POST /webhooks/plex?key=… (multipart form with a JSON "payload" field)
  keyed: {
    paths: ['/webhooks/plex'],
    async handle(req, res, url, { service: plex }) {
      const { Readable } = await import('node:stream');
      const request = new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Readable.toWeb(req), duplex: 'half' });
      const form = await request.formData();
      plex.handleWebhook(JSON.parse(form.get('payload')));
      return send(res, 200, { ok: true });
    },
  },
};
