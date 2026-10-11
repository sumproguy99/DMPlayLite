import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomId, fetchJson } from './util.js';
import { lanAddresses } from './net.js';
import { Auth, tokenFrom } from './auth.js';
import { normalizeWorkflow } from './tools.js';
import { handleMcp } from './mcp.js';
import { moonPhase, moonName, sunTimes } from './solar.js';

export { lanAddresses };

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
// Reachable without logging in (the login page itself, and machine endpoints guarded by the key).
const OPEN_FILES = new Set(['/login.html', '/style.css', '/favicon.svg']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString();
}
async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function createServer(app) {
  const { config, plex, hue, govee, lights, engine, log, port, discovery, ha, alexa, assistant, tools, scheduler, auth } = app;
  const { getConfig, updateConfig } = config;
  let plexServers = []; // from the last sign-in; tokens stay server-side

  const keyOk = (req, url) => {
    const k = url.searchParams.get('key') ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    return k === getConfig().webhookKey;
  };

  const publicState = (user) => {
    const c = getConfig();
    const base = lanAddresses().map((ip) => `http://${ip}:${port}`);
    const key = c.webhookKey;
    const sun = c.location?.lat ? sunTimes(new Date(), c.location.lat, c.location.lon) : null;
    const phase = moonPhase();
    return {
      user,
      routines: c.routines,
      groups: c.groups,
      plex: { url: c.plex.url, hasToken: Boolean(c.plex.token), pollSeconds: c.plex.pollSeconds, status: plex.status },
      hue: { bridgeIp: c.hue.bridgeIp, paired: hue.ready, candidates: discovery.list().filter((d) => d.kind === 'hue-bridge').map((d) => d.ip) },
      govee: { multicastInterface: c.govee.multicastInterface, devices: govee.list() },
      homeassistant: {
        url: c.homeassistant.url,
        hasToken: Boolean(c.homeassistant.token),
        status: ha.status,
        candidates: discovery.list().filter((d) => d.kind === 'home-assistant').map((d) => d.txt?.internal_url || d.txt?.base_url || `http://${d.ip}:8123`),
      },
      alexa: { enabled: c.alexa.enabled !== false, port: c.alexa.port ?? 80, status: alexa.status, items: alexa.items().map(({ id, key, name, kind }) => ({ id, key, name, kind })), hidden: c.alexa.hidden ?? [] },
      ai: { ready: assistant.ready, model: assistant.model, fromEnv: Boolean(process.env.ANTHROPIC_API_KEY) },
      location: c.location,
      sky: { sunrise: sun?.sunrise, sunset: sun?.sunset, moon: moonName(phase), moonPhase: phase },
      network: { status: discovery.status, online: discovery.list().filter((d) => d.online).length, total: discovery.devices.size },
      urls: {
        ui: base.slice(0, 1),
        plexWebhook: base.map((b) => `${b}/webhooks/plex?key=${key}`),
        hook: `${base[0]}/hooks/<name>?key=${key}`,
        run: `${base[0]}/run/<workflow>?key=${key}`,
        ask: `${base[0]}/ask?key=${key}&q=`,
        mcp: `${base[0]}/mcp?key=${key}`,
      },
    };
  };

  const routes = {
    // ---------- account ----------
    'GET /api/auth/me': (req, url, user) => ({ user, users: auth.users.map((u) => u.username) }),
    'POST /api/auth/logout': (req, url, user, res) => {
      auth.logout(tokenFrom(req));
      res.setHeader('Set-Cookie', Auth.clearCookie());
      return { ok: true };
    },
    'POST /api/auth/users': async (req) => {
      const { username, password } = await readJson(req);
      auth.createUser(username, password);
      log.info(`Account "${username}" created`);
      return { ok: true, users: auth.users.map((u) => u.username) };
    },
    'POST /api/auth/users/delete': async (req, url, user) => {
      const { username } = await readJson(req);
      if (username === user) throw new HttpError(400, "You can't delete the account you're signed in with");
      auth.deleteUser(username);
      return { ok: true, users: auth.users.map((u) => u.username) };
    },
    'POST /api/auth/password': async (req, url, user) => {
      const { password } = await readJson(req);
      auth.changePassword(user, password);
      return { ok: true };
    },

    // ---------- core ----------
    'GET /api/state': (req, url, user) => publicState(user),
    'GET /api/lights': async () => ({ lights: await lights.list(), groups: getConfig().groups }),
    'GET /api/log': () => log.entries,

    'PUT /api/routines': async (req) => {
      const routines = await readJson(req);
      if (!Array.isArray(routines)) throw new HttpError(400, 'Expected an array of workflows');
      let normalized;
      try {
        normalized = routines.map(normalizeWorkflow);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      updateConfig((c) => (c.routines = normalized));
      return { ok: true, routines: normalized };
    },
    'PUT /api/groups': async (req) => {
      const groups = await readJson(req);
      if (!Array.isArray(groups)) throw new HttpError(400, 'Expected an array of groups');
      for (const g of groups) {
        g.id ||= String(g.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomId(3);
        g.members ??= [];
      }
      updateConfig((c) => (c.groups = groups));
      return { ok: true, groups };
    },
    'POST /api/routines/run': async (req) => {
      const { id } = await readJson(req);
      const routine = getConfig().routines.find((r) => r.id === id);
      if (!routine) throw new HttpError(404, 'No such workflow');
      engine.run(routine, { source: 'manual', type: 'run' });
      return { ok: true };
    },
    'POST /api/simulate': async (req) => {
      const event = await readJson(req);
      engine.handle({ source: 'plex', ...event, simulated: true, at: new Date().toISOString() });
      return { ok: true };
    },
    'POST /api/lights/identify': async (req) => {
      const { target } = await readJson(req);
      await lights.identify(target);
      return { ok: true };
    },

    // ---------- network discovery ----------
    'GET /api/network': () => ({ status: discovery.status, devices: discovery.list() }),
    'POST /api/network/scan': async () => {
      await discovery.cycle();
      return { status: discovery.status, devices: discovery.list() };
    },
    'POST /api/network/rename': async (req) => {
      const { key, name } = await readJson(req);
      const d = discovery.devices.get(key);
      if (!d) throw new HttpError(404, 'No such device');
      d.customName = name || undefined;
      d.name = name || d.name;
      discovery.persist();
      return { ok: true };
    },

    // ---------- location / sky ----------
    'GET /api/location/search': async (req, url) => {
      const q = url.searchParams.get('q');
      const res = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=5&name=${encodeURIComponent(q)}`);
      return (res?.results ?? []).map((r) => ({ name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
    },
    'POST /api/location': async (req) => {
      const { lat, lon, name } = await readJson(req);
      if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) throw new HttpError(400, 'Latitude and longitude required');
      updateConfig((c) => (c.location = { lat: +lat, lon: +lon, name: name ?? '' }));
      return { ok: true };
    },

    // ---------- Plex ----------
    'POST /api/plex/pin': () => plex.createPin(),
    'POST /api/plex/pin/check': async (req) => {
      const { id } = await readJson(req);
      const token = await plex.checkPin(id);
      if (!token) return { done: false };
      plexServers = await plex.listServers(token);
      return { done: true, servers: plexServers.map(({ name, connections }, i) => ({ index: i, name, connections })) };
    },
    'POST /api/plex/settings': async (req) => {
      const body = await readJson(req);
      updateConfig((c) => {
        if (body.serverIndex != null) {
          const s = plexServers[body.serverIndex];
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

    // ---------- Hue ----------
    'POST /api/hue/discover': async () => {
      // Candidates from discovery (+ Philips MAC prefixes) and Philips' cloud lookup; keep only real bridges.
      const ips = new Set(discovery.list().filter((d) => d.kind === 'hue-bridge' || d.vendor === 'Philips Hue').map((d) => d.ip));
      for (const b of await hue.discover().catch(() => [])) ips.add(b.ip);
      const checked = await Promise.all([...ips].map(async (ip) => {
        const cfg = await fetchJson(`http://${ip}/api/config`, { timeoutMs: 2500 }).catch(() => null);
        return cfg?.bridgeid ? { id: cfg.bridgeid, ip, name: cfg.name } : null;
      }));
      return checked.filter(Boolean);
    },
    'POST /api/hue/pair': async (req) => {
      const { ip } = await readJson(req);
      if (!ip) throw new HttpError(400, 'Bridge IP required');
      const username = await hue.pair(ip);
      updateConfig((c) => (c.hue = { bridgeIp: ip, username }));
      log.info(`Hue: paired with bridge at ${ip}`);
      return { ok: true };
    },

    // ---------- Govee ----------
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

    // ---------- Home Assistant ----------
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
        if (!c.location?.lat && info.latitude) c.location = { lat: info.latitude, lon: info.longitude, name: info.location };
      });
      ha.restart();
      return { ok: true, info };
    },
    'GET /api/ha/entities': (req, url) => ha.entities(url.searchParams.get('q') ?? '', url.searchParams.get('domain') ?? '').slice(0, 300),

    // ---------- Alexa ----------
    'POST /api/alexa/settings': async (req) => {
      const body = await readJson(req);
      updateConfig((c) => (c.alexa = { ...c.alexa, ...('enabled' in body ? { enabled: body.enabled } : {}), ...(body.port ? { port: +body.port } : {}), ...(body.hidden ? { hidden: body.hidden } : {}) }));
      alexa.stop();
      alexa.start();
      return { ok: true };
    },

    // ---------- AI ----------
    'POST /api/ai/settings': async (req) => {
      const { apiKey, model } = await readJson(req);
      updateConfig((c) => (c.ai = { ...c.ai, ...(apiKey !== undefined ? { apiKey } : {}), ...(model !== undefined ? { model } : {}) }));
      return { ok: true, ready: assistant.ready };
    },
    'POST /api/ai/draft': async (req) => {
      const { text } = await readJson(req);
      if (!text?.trim()) throw new HttpError(400, 'Describe what you want to happen');
      return assistant.draft(text).catch((err) => {
        throw new HttpError(400, err.message);
      });
    },
    'POST /api/ai/ask': async (req) => {
      const { text } = await readJson(req);
      return { answer: await assistant.ask(text) };
    },
  };

  // ---------- machine endpoints (secret key) ----------
  async function handleKeyed(req, res, url) {
    if (!keyOk(req, url)) return send(res, 403, { error: 'Missing or wrong key' });
    const p = url.pathname;
    if (p === '/webhooks/plex') {
      const request = new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Readable.toWeb(req), duplex: 'half' });
      const form = await request.formData();
      plex.handleWebhook(JSON.parse(form.get('payload')));
      return send(res, 200, { ok: true });
    }
    if (p === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
      const reply = await handleMcp(JSON.parse((await readBody(req)) || 'null'), tools);
      if (!reply) return res.writeHead(202).end();
      return send(res, 200, reply);
    }
    if (p === '/ask') {
      // Siri: "Get Contents of URL" (GET ?q=… or POST text) → "Speak Text"
      const q = url.searchParams.get('q') ?? (req.method === 'POST' ? (await readBody(req)).trim() : '');
      const answer = q ? await assistant.ask(q).catch((e) => e.message) : 'What should I do?';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(answer);
    }
    if (p.startsWith('/run/')) {
      const q = decodeURIComponent(p.slice(5)).toLowerCase();
      const r = getConfig().routines.find((x) => x.id === q || x.name.toLowerCase() === q || x.voiceName?.toLowerCase() === q)
        ?? getConfig().routines.find((x) => x.name.toLowerCase().includes(q));
      res.writeHead(r ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!r) return res.end(`No workflow called ${q}`);
      engine.run(r, { source: 'webhook', type: 'run' });
      return res.end(`Running ${r.voiceName ?? r.name}`);
    }
    // Generic: /hooks/<name>  → trigger { source: 'webhook', event: '<name>' }
    const name = decodeURIComponent(p.slice('/hooks/'.length));
    const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
    const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'key'));
    engine.handle({ ...params, ...body, source: 'webhook', type: name, at: new Date().toISOString() });
    send(res, 200, { ok: true });
  }

  async function handleAuthPublic(req, res, url) {
    const ip = req.socket.remoteAddress;
    if (url.pathname === '/api/auth/status') return send(res, 200, { hasUsers: auth.hasUsers });
    const { username, password } = await readJson(req);
    if (url.pathname === '/api/auth/setup') {
      if (auth.hasUsers) throw new HttpError(403, 'Already set up — sign in instead');
      auth.createUser(username, password);
      log.info(`First account "${username}" created`);
    }
    try {
      const token = auth.login(username, password, ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookie(token) });
    } catch (err) {
      throw new HttpError(401, err.message);
    }
  }

  function streamLog(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    const onEntry = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    log.on('entry', onEntry);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      log.off('entry', onEntry);
    });
  }

  function serveStatic(res, pathname) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (p === '/webhooks/plex' || p.startsWith('/hooks/') || p.startsWith('/run/') || p === '/ask' || p === '/mcp') return await handleKeyed(req, res, url);
      if (['/api/auth/status', '/api/auth/login', '/api/auth/setup'].includes(p)) return await handleAuthPublic(req, res, url);
      if (OPEN_FILES.has(p)) return serveStatic(res, p);

      const user = auth.check(req);
      if (!user) {
        if (p.startsWith('/api/')) return send(res, 401, { error: 'Please sign in' });
        res.writeHead(302, { Location: '/login.html' }).end();
        return;
      }

      if (p === '/api/log/stream') return streamLog(req, res);
      const handler = routes[`${req.method} ${p}`];
      if (handler) return send(res, 200, await handler(req, url, user, res));
      if (p.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
      serveStatic(res, p);
    } catch (err) {
      if (!(err instanceof HttpError)) log.error(`${req.method} ${p}: ${err.message}`);
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
    }
  });
}
