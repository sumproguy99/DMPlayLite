// Cameras through Frigate NVR: object detections (person, car, dog, package…) become triggers, and phone alerts can carry a snapshot.
//   Detections arrive over MQTT — Frigate publishes <prefix>/events (new / update / end) to the same broker Playlite uses.
//   Camera list and snapshots come from Frigate's HTTP API: http://<frigate>:5000 (no login) or https://<frigate>:8971 with a
//   Frigate username/password (its self-signed certificate is accepted, LAN only).
//   -> engine events { source:'camera', type:'object' | 'object.end', camera, label, subLabel, zone, zones, score, eventId }
//      'object' fires once per detection when Frigate confirms it, and again (with "zone") each time it enters a new zone.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const MAX_IMAGE = 8 * 1024 * 1024;

// GET/POST that also works with self-signed HTTPS and user:pass@ URLs; resolves { status, headers, body: Buffer }.
export function rawRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMAGE) return req.destroy(new Error('answer too large'));
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('no answer')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? `nothing answered at ${u.host}` : err.message)));
    req.end(body);
  });
}

export class Frigate extends EventEmitter {
  status = { connected: false, lastError: null, version: null, lastEventAt: null };
  cameras = []; // [{ name, zones: [] }]
  recent = []; // last confirmed detections, newest first
  #token = null; // frigate_token cookie when logging in on port 8971
  #events = new Map(); // Frigate event id -> zones already announced

  constructor(getConfig, mqtt, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
    mqtt?.on('event', (e) => this.onMqtt(e));
  }

  get cfg() { return this.getConfig().frigate ?? {}; }
  get prefix() { return String(this.cfg.topicPrefix || 'frigate').replace(/\/+$/, ''); }

  async restart() {
    this.#token = null;
    this.cameras = [];
    if (!this.cfg.url) {
      this.status = { connected: false, lastError: null, version: null, lastEventAt: this.status.lastEventAt };
      return;
    }
    try {
      await this.load();
    } catch (err) {
      this.status.connected = false;
      this.status.lastError = err.message;
      this.log.warn(`Frigate: ${err.message}`);
    }
  }

  stop() {}

  // Check the connection and read the cameras and their zones. cfg overrides the saved settings (for "Test & save").
  async load(cfg = this.cfg) {
    const version = (await this.api('/api/version', cfg)).toString('utf8').trim().replace(/^"|"$/g, '');
    const config = JSON.parse((await this.api('/api/config', cfg)).toString('utf8'));
    const cameras = Object.entries(config.cameras ?? {})
      .filter(([, c]) => c.enabled !== false)
      .map(([name, c]) => ({ name, zones: Object.keys(c.zones ?? {}) }));
    if (cfg === this.cfg) {
      this.cameras = cameras;
      this.status = { ...this.status, connected: true, lastError: null, version };
    }
    return { version, cameras };
  }

  async #login(cfg) {
    const res = await rawRequest(new URL('/api/login', cfg.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: cfg.username, password: cfg.password }),
    });
    const cookie = [res.headers['set-cookie'] ?? []].flat().find((c) => c.startsWith('frigate_token='));
    if (res.status >= 400 || !cookie) throw new Error('Frigate refused the username or password');
    return cookie.split(';')[0];
  }

  // Frigate API call → Buffer. Logs in first when a username is set, and again if the session expired.
  async api(path, cfg = this.cfg) {
    if (!cfg.url) throw new Error('Frigate is not set up');
    const saved = cfg === this.cfg;
    let token = saved ? this.#token : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cfg.username && !token) token = await this.#login(cfg);
      const res = await rawRequest(new URL(path, cfg.url), { headers: token ? { Cookie: token } : {} });
      if (res.status === 401 && cfg.username && attempt === 0) {
        token = null;
        continue;
      }
      if (saved) this.#token = token;
      if (res.status === 401) throw new Error('Frigate wants a login — use port 8971 with a Frigate username and password, or port 5000');
      if (res.status !== 200) throw new Error(`Frigate answered HTTP ${res.status} for ${path.split('?')[0]}`);
      return res.body;
    }
  }

  onMqtt(e) {
    if (e.topic !== `${this.prefix}/events` || !e.json?.after) return;
    this.handleEvent(e.json);
  }

  handleEvent(msg) {
    const a = msg.after ?? {};
    if (!a.id || !a.camera) return;
    this.status.lastEventAt = new Date().toISOString();
    const seen = this.#events.get(a.id);
    const zones = a.entered_zones ?? [];
    const base = {
      source: 'camera',
      camera: a.camera,
      label: a.label,
      subLabel: Array.isArray(a.sub_label) ? a.sub_label[0] : a.sub_label ?? null,
      score: Math.round((a.top_score ?? a.score ?? 0) * 100),
      zones,
      eventId: a.id,
      at: new Date().toISOString(),
    };
    if (msg.type === 'end') {
      this.#events.delete(a.id);
      if (seen) this.emit('event', { ...base, type: 'object.end', zone: null });
      return;
    }
    if (a.false_positive === true) return; // Frigate hasn't confirmed it yet
    if (!seen) {
      this.#events.set(a.id, new Set(zones));
      if (this.#events.size > 500) this.#events.delete(this.#events.keys().next().value);
      this.recent.unshift({ camera: base.camera, label: base.label, subLabel: base.subLabel, score: base.score, zones, at: base.at });
      this.recent.length = Math.min(this.recent.length, 15);
      this.emit('event', { ...base, type: 'object', zone: null });
      return;
    }
    for (const zone of zones.filter((z) => !seen.has(z))) {
      seen.add(zone);
      this.emit('event', { ...base, type: 'object', zone });
    }
  }

  // A JPEG for a phone alert. spec: true/"" = the camera that triggered the workflow (that detection's snapshot),
  // a camera name = its latest frame, or a full http(s) URL = any camera's snapshot address (user:pass@ allowed).
  async snapshot(spec, event = {}) {
    const s = spec === true ? '' : String(spec ?? '').trim();
    if (/^https?:\/\//i.test(s)) {
      const res = await rawRequest(s);
      if (res.status !== 200) throw new Error(`snapshot URL answered HTTP ${res.status}`);
      return { data: res.body, name: 'snapshot.jpg' };
    }
    const camera = s || event.camera;
    if (!camera) throw new Error('which camera? (this workflow was not started by a camera)');
    if (event.eventId && event.camera === camera) {
      try {
        return { data: await this.api(`/api/events/${encodeURIComponent(event.eventId)}/snapshot.jpg?bbox=1`), name: `${camera}.jpg` };
      } catch {
        // no saved snapshot for that detection — use the live frame
      }
    }
    const known = this.cameras.find((c) => c.name.toLowerCase() === camera.toLowerCase())?.name ?? camera;
    return { data: await this.api(`/api/${encodeURIComponent(known)}/latest.jpg?h=720`), name: `${known}.jpg` };
  }
}
