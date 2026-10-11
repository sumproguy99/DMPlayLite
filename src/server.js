import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomId, fetchJson } from './util.js';
import { lanAddresses } from './net.js';
import { Auth, tokenFrom } from './auth.js';
import { normalizeWorkflow } from './tools.js';
import { handleMcp } from './mcp.js';
import { moonPhase, moonName, sunTimes } from './solar.js';
import { PLUGINS } from './plugins/index.js';
import { canHold } from './engine.js';
import { HttpError, readBody, readJson, send } from './http-utils.js';

export { lanAddresses };

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
// Reachable without logging in (the login page itself, and machine endpoints guarded by the key).
const OPEN_FILES = new Set(['/login.html', '/style.css', '/favicon.svg']);

export function createServer(app) {
  const { config, lights, engine, log, port, discovery, services, assistant, tools, scheduler, auth } = app;
  const { getConfig, updateConfig } = config;
  // what plugin routes / keyed handlers get (plus their own service)
  const pluginCtx = { getConfig, updateConfig, log, discovery, engine, lights, services };
  const active = PLUGINS.filter((p) => services[p.id]);
  // keyed machine endpoints that plugins add (e.g. /webhooks/plex, /presence/…)
  const keyedPlugin = (p) => active.find((x) => x.keyed?.paths?.includes(p) || x.keyed?.prefixes?.some((pre) => p.startsWith(pre)));
  // which trigger events can use "…for N minutes", for the UI
  const holdable = () => {
    const out = { network: ['device.online', 'device.offline'], mode: ['mode.changed'] };
    for (const p of PLUGINS) {
      const ev = (p.trigger?.events ?? []).filter((event) => canHold({ source: p.trigger.source, event }));
      if (ev.length) out[p.trigger.source] = ev;
    }
    return out;
  };

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
      mode: engine.mode,
      modes: c.modes,
      waiting: engine.waiting,
      scenes: (c.scenes ?? []).map((s) => ({ id: s.id, name: s.name, lights: Object.keys(s.lights), savedAt: s.savedAt })),
      ai: { ready: assistant.ready, model: assistant.model, fromEnv: Boolean(process.env.ANTHROPIC_API_KEY) },
      ntfy: { server: c.ntfy.server, topic: c.ntfy.topic, hasToken: Boolean(c.ntfy.token) },
      location: c.location,
      sky: { sunrise: sun?.sunrise, sunset: sun?.sunset, moon: moonName(phase), moonPhase: phase },
      network: { status: discovery.status, online: discovery.list().filter((d) => d.online).length, total: discovery.devices.size },
      holdable: holdable(),
      ...Object.assign({}, ...active.map((p) => p.state?.(services[p.id], { config: c, discovery }) ?? {})),
      urls: {
        ui: base.slice(0, 1),
        plexWebhook: base.map((b) => `${b}/webhooks/plex?key=${key}`),
        hook: `${base[0]}/hooks/<name>?key=${key}`,
        run: `${base[0]}/run/<workflow>?key=${key}`,
        mode: `${base[0]}/mode/<mode>?key=${key}`,
        scene: `${base[0]}/scene/<scene>?key=${key}`,
        presence: `${base[0]}/presence/<person>/<state>?key=${key}`,
        owntracks: `${base[0]}/presence/owntracks?key=${key}&person=<person>`,
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
    'POST /api/mode': async (req, url, user) => {
      const { mode } = await readJson(req);
      try {
        engine.setMode(mode, user);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return { ok: true, mode: engine.mode };
    },
    'POST /api/scenes': async (req) => {
      const { name, targets } = await readJson(req);
      try {
        const { scene, skipped } = await engine.saveScene(name, targets);
        return { ok: true, id: scene.id, skipped };
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
    'POST /api/scenes/apply': async (req) => {
      const { id, transitionMs } = await readJson(req);
      if (!engine.findScene(id)) throw new HttpError(404, 'No such scene');
      await engine.applyScene(id, transitionMs ?? 0);
      return { ok: true };
    },
    'POST /api/scenes/delete': async (req) => {
      const { id } = await readJson(req);
      updateConfig((c) => (c.scenes = (c.scenes ?? []).filter((s) => s.id !== id)));
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
      services.weather?.restart();
      return { ok: true };
    },
    // ---------- phone alerts (ntfy) ----------
    'POST /api/ntfy/settings': async (req) => {
      const { server, topic, token } = await readJson(req);
      if (server !== undefined && server !== '' && !/^https?:\/\/[^\s/]+/.test(server)) throw new HttpError(400, 'Server must be a full http(s) URL');
      if (topic !== undefined && topic !== '' && !/^[\w-]{1,64}$/.test(topic)) throw new HttpError(400, 'Topic can only use letters, numbers, - and _ (max 64)');
      updateConfig((c) => (c.ntfy = {
        ...c.ntfy,
        ...(server !== undefined ? { server: server.trim() || 'https://ntfy.sh' } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(token !== undefined ? { token } : {}),
      }));
      return { ok: true };
    },
    'POST /api/ntfy/test': async () => {
      try {
        await engine.sendNtfy({ title: 'Playlite', message: 'Test alert — phone alerts are working 🎉', tags: 'bulb' });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
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
  for (const p of active) Object.assign(routes, p.routes?.(services[p.id], pluginCtx));
  const rawRoutes = Object.fromEntries(active.flatMap((p) => Object.entries(p.raw ?? {}).map(([path, fn]) => [path, (req, res, url) => fn(req, res, url, { ...pluginCtx, service: services[p.id] })])));

  // ---------- machine endpoints (secret key) ----------
  async function handleKeyed(req, res, url) {
    if (!keyOk(req, url)) return send(res, 403, { error: 'Missing or wrong key' });
    const p = url.pathname;
    const plugin = keyedPlugin(p);
    if (plugin) return plugin.keyed.handle(req, res, url, { ...pluginCtx, service: services[plugin.id] });
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
    if (p.startsWith('/mode/')) {
      // Siri: "Hey Siri, movie mode" → GET /mode/movie
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try {
        engine.setMode(decodeURIComponent(p.slice(6)), 'Siri/webhook');
      } catch (err) {
        return res.writeHead(400).end(err.message);
      }
      return res.writeHead(200).end(`House mode is now ${engine.mode}`);
    }
    if (p.startsWith('/scene/')) {
      // Siri: "Hey Siri, reading lights" → GET /scene/reading
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const scene = engine.findScene(decodeURIComponent(p.slice(7)));
      if (!scene) return res.writeHead(404).end(`No scene called ${decodeURIComponent(p.slice(7))}`);
      engine.applyScene(scene.id, Number(url.searchParams.get('fade') ?? 0) * 1000).catch((err) => log.error(`Scene: ${err.message}`));
      return res.writeHead(200).end(`${scene.name} is on`);
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
      if (keyedPlugin(p) || p.startsWith('/hooks/') || p.startsWith('/run/') || p.startsWith('/mode/') || p.startsWith('/scene/') || p === '/ask' || p === '/mcp') return await handleKeyed(req, res, url);
      if (['/api/auth/status', '/api/auth/login', '/api/auth/setup'].includes(p)) return await handleAuthPublic(req, res, url);
      if (OPEN_FILES.has(p)) return serveStatic(res, p);

      const user = auth.check(req);
      if (!user) {
        if (p.startsWith('/api/')) return send(res, 401, { error: 'Please sign in' });
        res.writeHead(302, { Location: '/login.html' }).end();
        return;
      }

      if (p === '/api/log/stream') return streamLog(req, res);
      if (rawRoutes[p]) return await rawRoutes[p](req, res, url);
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
