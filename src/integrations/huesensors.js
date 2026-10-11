// Hue motion sensors, buttons/dimmers and contact sensors, live from the bridge's API v2 event stream.
//   GET https://<bridge>/eventstream/clip/v2  (server-sent events, header hue-application-key = the paired username)
//   -> engine events { source:'hue', type:'motion'|'button'|'contact', device, to?, button?, press? }
// The bridge serves HTTPS with its own self-signed certificate, so it isn't verified (LAN only, like the v1 API's plain HTTP).
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const SENSOR_KINDS = ['motion', 'button', 'contact'];

export class HueSensors extends EventEmitter {
  status = { connected: false, lastError: null };
  resources = new Map(); // service id -> { device, kind, button }
  baseUrl = null; // override for tests, e.g. http://127.0.0.1:1234
  #req = null;
  #stopped = true;
  #backoff = 2000;
  #reload = null;

  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().hue ?? {}; }
  get ready() { return Boolean(this.cfg.bridgeIp && this.cfg.username); }
  get base() { return this.baseUrl ?? `https://${this.cfg.bridgeIp}`; }

  #open(path, accept, onResponse) {
    const url = new URL(path, this.base);
    const lib = url.protocol === 'https:' ? https : http;
    return lib.request(url, { headers: { 'hue-application-key': this.cfg.username, Accept: accept }, rejectUnauthorized: false }, onResponse);
  }

  #getJson(path) {
    return new Promise((resolve, reject) => {
      const req = this.#open(path, 'application/json', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 403 || res.statusCode === 401) return reject(new Error('the bridge rejected Playlite — pair it again'));
          if (res.statusCode !== 200) return reject(new Error(`bridge answered HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body).data ?? []);
          } catch {
            reject(new Error('unexpected answer from the bridge'));
          }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('the bridge did not answer (is it on API v2 / recent firmware?)')));
      req.on('error', reject);
      req.end();
    });
  }

  // Map each sensor service id to its device name (and button number).
  async loadResources() {
    const [devices, buttons] = await Promise.all([this.#getJson('/clip/v2/resource/device'), this.#getJson('/clip/v2/resource/button')]);
    this.resources.clear();
    for (const d of devices) {
      for (const s of d.services ?? []) {
        if (SENSOR_KINDS.includes(s.rtype)) this.resources.set(s.rid, { device: d.metadata?.name ?? 'Hue device', kind: s.rtype });
      }
    }
    for (const b of buttons) {
      const r = this.resources.get(b.id);
      if (r) r.button = b.metadata?.control_id;
    }
  }

  sensors() {
    const byDevice = new Map();
    for (const r of this.resources.values()) {
      const kinds = byDevice.get(r.device) ?? new Set();
      kinds.add(r.kind);
      byDevice.set(r.device, kinds);
    }
    return [...byDevice].map(([name, kinds]) => ({ name, kinds: [...kinds] }));
  }

  restart() {
    this.stop();
    if (!this.ready) {
      this.status = { connected: false, lastError: 'Pair the Hue bridge first' };
      return;
    }
    this.#stopped = false;
    this.#backoff = 2000;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#req?.destroy();
    this.#req = null;
    this.status.connected = false;
  }

  async #connect() {
    if (this.#stopped) return;
    try {
      await this.loadResources();
    } catch (err) {
      this.status.lastError = err.message;
      return this.#retry(null);
    }
    if (this.#stopped) return;
    const req = this.#open('/eventstream/clip/v2', 'text/event-stream', (res) => {
      if (res.statusCode !== 200) {
        this.status.lastError = `event stream: HTTP ${res.statusCode}`;
        res.resume();
        return;
      }
      this.#backoff = 2000;
      this.status = { connected: true, lastError: null };
      this.log.info(`Hue sensors: listening (${this.sensors().length} sensors/buttons)`);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk.replace(/\r\n/g, '\n');
        for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
          this.#onBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
    });
    this.#req = req;
    req.on('error', (err) => {
      if (this.#req === req) this.status.lastError = err.message;
    });
    req.on('close', () => this.#retry(req));
    req.end();
  }

  #retry(req) {
    if (req && this.#req !== req) return; // a newer connection replaced this one
    if (this.status.connected) this.log.warn('Hue sensors: event stream closed, retrying…');
    this.status.connected = false;
    if (this.#stopped) return;
    setTimeout(() => this.#connect(), this.#backoff).unref?.();
    this.#backoff = Math.min(this.#backoff * 2, 60_000);
  }

  #onBlock(block) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    if (!data) return;
    let containers;
    try {
      containers = JSON.parse(data);
    } catch {
      return;
    }
    for (const c of containers) {
      if (c.type === 'update') for (const r of c.data ?? []) this.#onResource(r);
      else if (c.type === 'add' || c.type === 'delete') {
        clearTimeout(this.#reload); // a sensor was paired or removed — refresh names shortly
        this.#reload = setTimeout(() => this.loadResources().catch(() => {}), 2000);
      }
    }
  }

  #onResource(r) {
    const known = this.resources.get(r.id);
    if (!known) return;
    const base = { source: 'hue', device: known.device, at: new Date().toISOString() };
    if (r.type === 'motion') {
      const motion = r.motion?.motion_report?.motion ?? r.motion?.motion;
      if (motion != null) this.emit('event', { ...base, type: 'motion', to: motion ? 'detected' : 'clear' });
    } else if (r.type === 'button') {
      const press = r.button?.button_report?.event ?? r.button?.last_event;
      // every press also sends initial_press (and repeat while held) — only log those if a workflow uses them
      if (press) this.emit('event', { ...base, type: 'button', button: known.button, press, chatty: press === 'initial_press' || press === 'repeat' });
    } else if (r.type === 'contact') {
      const state = r.contact_report?.state;
      if (state) this.emit('event', { ...base, type: 'contact', to: state === 'contact' ? 'closed' : 'open' });
    }
  }
}
