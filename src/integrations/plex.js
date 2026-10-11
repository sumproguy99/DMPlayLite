// Plex Media Server integration. Two independent event sources, de-duplicated:
//
//  1. Live (no Plex Pass needed): the server's WebSocket notification feed nudges us
//     to re-read /status/sessions; we diff session states to get play/pause/resume/stop.
//     A slow poll backs this up in case the socket drops.
//  2. Webhooks (Plex Pass): Plex POSTs to /webhooks/plex?key=... — fastest & most exact.
//
// "player.online" (Plex app opened on a device) is best-effort: we watch the server's
// /clients list and plex.tv device presence, and fire when a player appears.
import { EventEmitter } from 'node:events';
import { fetchJson, redact } from '../util.js';

const PRODUCT = 'Playlite';

export class PlexIntegration extends EventEmitter {
  status = { connected: false, socket: 'off', lastError: null, lastPoll: null, sessions: 0, players: [] };
  #sessions = null; // sessionKey -> snapshot
  #online = null; // player id -> name
  #recent = new Map(); // dedupe key -> ts
  #lastStop = new Map(); // player id -> ts
  #timers = [];
  #ws = null;
  #wsBackoff = 1000;
  #refreshQueued = null;
  #stopped = true;

  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().plex; }

  headers(token = this.cfg.token) {
    return {
      Accept: 'application/json',
      'X-Plex-Product': PRODUCT,
      'X-Plex-Client-Identifier': this.cfg.clientId,
      'X-Plex-Device-Name': 'Playlite',
      ...(token ? { 'X-Plex-Token': token } : {}),
    };
  }

  // ---------- lifecycle ----------

  restart() {
    this.stop();
    if (!this.cfg.url || !this.cfg.token) {
      this.status = { ...this.status, connected: false, socket: 'off', lastError: 'Not configured' };
      return;
    }
    this.#stopped = false;
    this.#sessions = null;
    this.#online = null;
    this.#connectSocket();
    this.refreshSessions();
    this.refreshPlayers();
    const poll = Math.max(3, this.cfg.pollSeconds ?? 10) * 1000;
    this.#timers.push(setInterval(() => this.refreshSessions(), poll));
    this.#timers.push(setInterval(() => this.refreshPlayers(), 15_000));
  }

  stop() {
    this.#stopped = true;
    this.#timers.forEach(clearInterval);
    this.#timers = [];
    this.#ws?.close();
    this.#ws = null;
  }

  #connectSocket() {
    if (this.#stopped) return;
    const url = new URL('/:/websockets/notifications', this.cfg.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('X-Plex-Token', this.cfg.token);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.status.socket = 'error';
      this.status.lastError = err.message;
      return;
    }
    this.#ws = ws;
    this.status.socket = 'connecting';
    ws.onopen = () => {
      this.#wsBackoff = 1000;
      this.status.socket = 'live';
      this.log.info('Plex: live notification socket connected');
    };
    ws.onmessage = (msg) => {
      try {
        const type = JSON.parse(msg.data)?.NotificationContainer?.type;
        if (type === 'playing') this.#queueRefresh();
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.status.socket = 'reconnecting';
      if (!this.#stopped) setTimeout(() => this.#connectSocket(), this.#wsBackoff);
      this.#wsBackoff = Math.min(this.#wsBackoff * 2, 60_000);
    };
    ws.onerror = () => {}; // onclose handles retry
  }

  #queueRefresh() {
    clearTimeout(this.#refreshQueued);
    this.#refreshQueued = setTimeout(() => this.refreshSessions(), 250);
  }

  // ---------- sessions -> play/pause/resume/stop ----------

  async refreshSessions() {
    if (this.#stopped) return;
    let data;
    try {
      data = await fetchJson(new URL('/status/sessions', this.cfg.url), { headers: this.headers() });
      this.status.connected = true;
      this.status.lastError = null;
      this.status.lastPoll = new Date().toISOString();
    } catch (err) {
      if (this.status.lastError !== err.message) this.log.warn(`Plex: ${redact(err.message)}`);
      this.status.connected = false;
      this.status.lastError = err.message;
      return;
    }
    const next = new Map();
    for (const m of data?.MediaContainer?.Metadata ?? []) {
      next.set(String(m.sessionKey), {
        state: m.Player?.state,
        player: m.Player?.title ?? m.Player?.product ?? 'Unknown player',
        playerId: m.Player?.machineIdentifier,
        user: m.User?.title,
        mediaType: m.type,
        title: m.grandparentTitle ? `${m.grandparentTitle} — ${m.title}` : m.title,
      });
    }
    this.status.sessions = next.size;
    const prev = this.#sessions;
    this.#sessions = next;
    if (!prev) {
      // First snapshot: learn what's already playing without firing routines.
      for (const s of next.values()) s.announced = true;
      return;
    }
    for (const event of diffSessions(prev, next)) this.#emit(event);
  }

  // ---------- webhooks ----------

  handleWebhook(payload) {
    const map = { 'media.play': 'media.play', 'media.pause': 'media.pause', 'media.resume': 'media.resume', 'media.stop': 'media.stop', 'media.scrobble': 'media.scrobble' };
    const type = map[payload?.event];
    if (!type) return;
    this.#emit({
      type,
      player: payload.Player?.title,
      playerId: payload.Player?.uuid,
      user: payload.Account?.title,
      mediaType: payload.Metadata?.type,
      title: payload.Metadata?.grandparentTitle ? `${payload.Metadata.grandparentTitle} — ${payload.Metadata.title}` : payload.Metadata?.title,
    });
  }

  // ---------- players -> player.online / player.offline ----------

  async refreshPlayers() {
    if (this.#stopped) return;
    const online = new Map();
    const [local, cloud] = await Promise.allSettled([
      fetchJson(new URL('/clients', this.cfg.url), { headers: this.headers() }),
      fetchJson('https://clients.plex.tv/api/v2/resources?includeHttps=1', { headers: this.headers(), timeoutMs: 8000 }),
    ]);
    if (local.status === 'fulfilled') {
      for (const c of local.value?.MediaContainer?.Server ?? []) online.set(c.machineIdentifier, c.name);
    }
    if (cloud.status === 'fulfilled') {
      for (const r of cloud.value ?? []) {
        if (r.presence && String(r.provides).includes('player')) online.set(r.clientIdentifier, r.name);
      }
    }
    // Currently-playing devices are obviously online too.
    for (const s of this.#sessions?.values() ?? []) if (s.playerId) online.set(s.playerId, s.player);
    if (local.status === 'rejected' && cloud.status === 'rejected') return;

    this.status.players = [...online.values()].sort();
    const prev = this.#online;
    this.#online = online;
    if (!prev) return;
    for (const [id, name] of online) if (!prev.has(id)) this.#emit({ type: 'player.online', player: name, playerId: id });
    for (const [id, name] of prev) if (!online.has(id)) this.#emit({ type: 'player.offline', player: name, playerId: id });
  }

  // ---------- shared ----------

  #emit(event) {
    const now = Date.now();
    const key = `${event.type}|${event.playerId ?? event.player}`;
    if (now - (this.#recent.get(key) ?? 0) < 4000) return; // same event from webhook + socket
    this.#recent.set(key, now);
    if (this.#recent.size > 200) this.#recent.clear();

    const pid = event.playerId ?? event.player;
    if (event.type === 'media.stop') this.#lastStop.set(pid, now);
    // Autoplay of the next episode shows up as stop -> play within a few seconds.
    if (event.type === 'media.play' && now - (this.#lastStop.get(pid) ?? 0) < 15_000) event.continued = true;

    this.emit('event', { source: 'plex', ...event, at: new Date(now).toISOString() });
  }

  // ---------- sign-in helpers (plex.tv PIN flow) ----------

  async createPin() {
    const pin = await fetchJson('https://plex.tv/api/v2/pins?strong=true', { method: 'POST', headers: this.headers(null) });
    const params = new URLSearchParams({ clientID: this.cfg.clientId, code: pin.code, 'context[device][product]': PRODUCT });
    return { id: pin.id, authUrl: `https://app.plex.tv/auth#?${params}` };
  }

  async checkPin(id) {
    const pin = await fetchJson(`https://plex.tv/api/v2/pins/${encodeURIComponent(id)}`, { headers: this.headers(null) });
    return pin.authToken ?? null;
  }

  async listServers(token) {
    const resources = await fetchJson('https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=0', {
      headers: this.headers(token),
      timeoutMs: 8000,
    });
    return (resources ?? [])
      .filter((r) => String(r.provides).includes('server'))
      .map((r) => ({
        name: r.name,
        token: r.accessToken ?? token,
        connections: (r.connections ?? [])
          .filter((c) => !c.relay)
          .map((c) => ({ local: c.local, url: c.local ? `http://${c.address}:${c.port}` : c.uri })),
      }));
  }
}

// Pure diff of two session snapshots -> normalized events.
export function diffSessions(prev, next) {
  const events = [];
  for (const [key, s] of next) {
    const before = prev.get(key);
    const base = { player: s.player, playerId: s.playerId, user: s.user, mediaType: s.mediaType, title: s.title };
    if (s.state === 'buffering' && before) s.state = before.state; // ignore buffering blips
    s.announced = before?.announced ?? false;
    if (s.state === 'playing' && !s.announced) {
      // First time we see it actually playing (new sessions often start as "buffering").
      events.push({ type: 'media.play', ...base });
      s.announced = true;
    } else if (s.announced && before.state === 'playing' && s.state === 'paused') {
      events.push({ type: 'media.pause', ...base });
    } else if (s.announced && before.state === 'paused' && s.state === 'playing') {
      events.push({ type: 'media.resume', ...base });
    }
  }
  for (const [key, s] of prev) {
    if (!next.has(key)) {
      events.push({ type: 'media.stop', player: s.player, playerId: s.playerId, user: s.user, mediaType: s.mediaType, title: s.title });
    }
  }
  return events;
}
