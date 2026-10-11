// MQTT bridge (built-in MQTT 3.1.1 client, no dependencies).
//   In:  every message on the broker -> engine events { source:'mqtt', type:'message', topic, payload, json, prevJson }
//        Zigbee2MQTT, Tasmota, ESPHome, Frigate, rtl_433, OwnTracks… all publish here.
//   Out: publish(topic, payload) — e.g. zigbee2mqtt/Lamp/set {"state":"ON"}, cmnd/plug/POWER ON.
// Config: mqtt { url: 'mqtt://host:1883' | 'mqtts://host:8883', username, password }.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { randomId } from '../util.js';

const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
const CONNACK_ERRORS = { 1: 'broker does not support MQTT 3.1.1', 2: 'client id rejected', 3: 'broker unavailable', 4: 'wrong username or password', 5: 'not authorized' };
const KEEPALIVE_S = 60;
const MAX_TOPICS = 500;

// ---------- packet codec ----------
const str = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

function remainingLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

export const packet = (type, flags, body = Buffer.alloc(0)) => Buffer.concat([Buffer.from([(type << 4) | flags]), remainingLength(body.length), body]);

export function connectPacket({ clientId, username, password, keepalive = KEEPALIVE_S }) {
  const flags = 0x02 | (username ? 0x80 : 0) | (username && password ? 0x40 : 0); // clean session
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepalive);
  const parts = [str('MQTT'), Buffer.from([4, flags]), ka, str(clientId)];
  if (username) parts.push(str(username));
  if (username && password) parts.push(str(password));
  return packet(T.CONNECT, 0, Buffer.concat(parts));
}

export function publishPacket(topic, payload, { retain = false } = {}) {
  return packet(T.PUBLISH, retain ? 1 : 0, Buffer.concat([str(topic), Buffer.from(payload ?? '', 'utf8')]));
}

export function subscribePacket(id, topics) {
  const pid = Buffer.alloc(2);
  pid.writeUInt16BE(id);
  return packet(T.SUBSCRIBE, 0x02, Buffer.concat([pid, ...topics.flatMap((t) => [str(t), Buffer.from([1])])]));
}

// Splits a byte stream into packets. Returns { packets, rest }.
export function parsePackets(buf) {
  const packets = [];
  let off = 0;
  while (buf.length - off >= 2) {
    let len = 0;
    let mult = 1;
    let i = off + 1;
    let complete = false;
    for (let n = 0; n < 4 && i < buf.length; n++, i++) {
      len += (buf[i] & 127) * mult;
      mult *= 128;
      if (!(buf[i] & 128)) {
        complete = true;
        i++;
        break;
      }
    }
    if (!complete || buf.length < i + len) break;
    packets.push({ type: buf[off] >> 4, flags: buf[off] & 15, body: buf.subarray(i, i + len) });
    off = i + len;
  }
  return { packets, rest: buf.subarray(off) };
}

export function decodePublish({ flags, body }) {
  const tlen = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + tlen).toString('utf8');
  const qos = (flags >> 1) & 3;
  let off = 2 + tlen;
  const id = qos > 0 ? body.readUInt16BE(off) : null;
  if (qos > 0) off += 2;
  return { topic, qos, id, retain: Boolean(flags & 1), payload: body.subarray(off).toString('utf8') };
}

// MQTT wildcards: + matches one level, # matches the rest.
export function topicMatches(pattern, topic) {
  if (!pattern) return true;
  const p = String(pattern).split('/');
  const t = String(topic).split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length) return false;
    if (p[i] !== '+' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

const parseJson = (s) => {
  if (!/^\s*[[{]/.test(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

// ---------- integration ----------
export class Mqtt extends EventEmitter {
  status = { connected: false, lastError: null, messages: 0 };
  topics = new Map(); // topic -> { payload, json, at } (most recent first-seen order, capped)
  #sock = null;
  #buf = Buffer.alloc(0);
  #backoff = 2000;
  #stopped = true;
  #ping = null;
  #lastData = 0;
  #pid = 1;

  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().mqtt ?? {}; }
  get ready() { return Boolean(this.cfg.url); }

  restart() {
    this.stop();
    if (!this.ready) {
      this.status = { ...this.status, connected: false, lastError: 'Not configured' };
      return;
    }
    this.#stopped = false;
    this.#backoff = 2000;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#ping);
    if (this.#sock) {
      if (this.status.connected) this.#sock.write(packet(T.DISCONNECT, 0));
      this.#sock.destroy();
    }
    this.#sock = null;
    this.status.connected = false;
  }

  // Connect once with the given settings and report success or the reason it failed.
  static test(settings, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const probe = new Mqtt(() => ({ mqtt: settings }), { info() {}, warn() {}, error() {} });
      const done = (err) => {
        clearTimeout(timer);
        probe.stop();
        err ? reject(err) : resolve({ ok: true });
      };
      const timer = setTimeout(() => done(new Error(`no answer from ${settings.url} within ${timeoutMs / 1000}s`)), timeoutMs);
      probe.once('connected', () => done());
      probe.once('failed', (msg) => done(new Error(msg)));
      probe.#stopped = false;
      probe.#connect(false);
    });
  }

  #connect(retry = true) {
    if (this.#stopped) return;
    let url;
    try {
      url = new URL(this.cfg.url);
      if (!['mqtt:', 'mqtts:', 'tcp:', 'ssl:'].includes(url.protocol)) throw new Error();
    } catch {
      this.status.lastError = 'URL should look like mqtt://192.168.1.10:1883';
      this.emit('failed', this.status.lastError);
      return;
    }
    const secure = url.protocol === 'mqtts:' || url.protocol === 'ssl:';
    const opts = { host: url.hostname, port: Number(url.port || (secure ? 8883 : 1883)) };
    const sock = secure ? tls.connect({ ...opts, servername: url.hostname }) : net.connect(opts);
    this.#sock = sock;
    this.#buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      sock.write(connectPacket({
        clientId: this.cfg.clientId || `playlite-${randomId(4)}`,
        username: this.cfg.username || decodeURIComponent(url.username),
        password: this.cfg.password || decodeURIComponent(url.password),
      }));
    });
    sock.on('data', (d) => this.#onData(sock, d));
    sock.on('error', (err) => {
      this.status.lastError = err.code === 'ECONNREFUSED' ? `can't reach ${opts.host}:${opts.port} (connection refused)` : err.message;
      this.emit('failed', this.status.lastError);
    });
    sock.on('close', () => {
      if (this.#sock !== sock) return;
      clearInterval(this.#ping);
      if (this.status.connected) this.log.warn('MQTT: disconnected, retrying…');
      this.status.connected = false;
      if (retry && !this.#stopped) setTimeout(() => this.#connect(), this.#backoff).unref?.();
      this.#backoff = Math.min(this.#backoff * 2, 60_000);
    });
  }

  #onData(sock, data) {
    this.#lastData = Date.now();
    const { packets, rest } = parsePackets(Buffer.concat([this.#buf, data]));
    this.#buf = Buffer.from(rest);
    for (const p of packets) {
      if (p.type === T.CONNACK) {
        const code = p.body[1];
        if (code) {
          this.status.lastError = CONNACK_ERRORS[code] ?? `refused (code ${code})`;
          this.log.error(`MQTT: ${this.status.lastError}`);
          this.emit('failed', this.status.lastError);
          this.#stopped = true; // don't hammer the broker with bad credentials
          sock.destroy();
          return;
        }
        this.#backoff = 2000;
        this.status = { ...this.status, connected: true, lastError: null };
        sock.write(subscribePacket(this.#pid++, ['#']));
        clearInterval(this.#ping);
        this.#ping = setInterval(() => {
          if (Date.now() - this.#lastData > KEEPALIVE_S * 1500) sock.destroy(); // broker went quiet
          else sock.write(packet(T.PINGREQ, 0));
        }, (KEEPALIVE_S / 2) * 1000);
        this.#ping.unref?.();
        this.log.info(`MQTT: connected to ${this.cfg.url.replace(/\/\/[^@/]*@/, '//')}`);
        this.emit('connected');
      } else if (p.type === T.PUBLISH) {
        const msg = decodePublish(p);
        if (msg.qos === 1) {
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(msg.id);
          sock.write(packet(T.PUBACK, 0, ack));
        }
        this.#onMessage(msg);
      }
    }
  }

  #onMessage({ topic, payload, retain }) {
    this.status.messages++;
    const prev = this.topics.get(topic);
    const json = parseJson(payload);
    this.topics.delete(topic);
    this.topics.set(topic, { payload, json, at: new Date().toISOString() });
    if (this.topics.size > MAX_TOPICS) this.topics.delete(this.topics.keys().next().value);
    // Retained messages arrive on every (re)connect — they're old news, so remember them without firing workflows.
    if (retain) return;
    this.emit('event', { source: 'mqtt', type: 'message', topic, payload, json, prevJson: prev?.json, chatty: true, at: new Date().toISOString() });
  }

  publish(topic, payload, { retain = false } = {}) {
    if (!this.status.connected) throw new Error('MQTT is not connected');
    if (!topic || /[+#]/.test(topic)) throw new Error('Publish needs a plain topic (no + or # wildcards)');
    const body = typeof payload === 'string' ? payload : payload == null ? '' : JSON.stringify(payload);
    this.#sock.write(publishPacket(topic, body, { retain }));
  }

  recent(query = '') {
    const q = query.toLowerCase();
    return [...this.topics].reverse()
      .filter(([t]) => !q || t.toLowerCase().includes(q))
      .map(([topic, m]) => ({ topic, payload: m.payload.length > 300 ? `${m.payload.slice(0, 300)}…` : m.payload, at: m.at }));
  }
}
