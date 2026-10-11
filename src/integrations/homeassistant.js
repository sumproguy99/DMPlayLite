// Home Assistant bridge.
//   In:  WebSocket state_changed events  -> engine events { source:'homeassistant', type:'state', entity, from, to }
//   Out: REST service calls (any domain), and HA lights act as Playlite lights (ha:light.kitchen).
// Auth: a Long-Lived Access Token (HA → your profile → Security).
import { EventEmitter } from 'node:events';
import { clamp, fetchJson, hexToRgb } from '../util.js';

export class HomeAssistant extends EventEmitter {
  supportsTransition = true;
  states = new Map(); // entity_id -> state object
  status = { connected: false, lastError: null, version: null, entities: 0 };
  #ws = null;
  #msgId = 1;
  #backoff = 2000;
  #stopped = true;

  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().homeassistant ?? {}; }
  get ready() { return Boolean(this.cfg.url && this.cfg.token); }

  #headers() {
    return { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' };
  }

  restart() {
    this.stop();
    if (!this.ready) {
      this.status = { ...this.status, connected: false, lastError: 'Not configured' };
      return;
    }
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#ws?.close();
    this.#ws = null;
  }

  async test(url, token) {
    const res = await fetchJson(`${url.replace(/\/+$/, '')}/api/config`, { headers: { Authorization: `Bearer ${token}` } });
    return { version: res.version, location: res.location_name, latitude: res.latitude, longitude: res.longitude };
  }

  #connect() {
    if (this.#stopped) return;
    const url = new URL('/api/websocket', this.cfg.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.onmessage = (m) => this.#onMessage(JSON.parse(m.data));
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      if (this.status.connected) this.log.warn('Home Assistant: disconnected, retrying…');
      this.status.connected = false;
      if (!this.#stopped) setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 60_000);
    };
    ws.onerror = () => {};
  }

  #send(msg) {
    const id = this.#msgId++;
    this.#ws?.send(JSON.stringify({ id, ...msg }));
    return id;
  }

  async #onMessage(msg) {
    if (msg.type === 'auth_required') {
      this.#ws.send(JSON.stringify({ type: 'auth', access_token: this.cfg.token }));
    } else if (msg.type === 'auth_invalid') {
      this.status.lastError = 'Token rejected by Home Assistant';
      this.log.error('Home Assistant: access token was rejected');
      this.stop();
    } else if (msg.type === 'auth_ok') {
      this.#backoff = 2000;
      this.status = { ...this.status, connected: true, lastError: null, version: msg.ha_version };
      this.#send({ type: 'subscribe_events', event_type: 'state_changed' });
      await this.refreshStates().catch((e) => this.log.warn(`Home Assistant: ${e.message}`));
      this.log.info(`Home Assistant ${msg.ha_version}: connected, ${this.states.size} entities`);
    } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const { entity_id, old_state, new_state } = msg.event.data;
      if (new_state) this.states.set(entity_id, new_state);
      else this.states.delete(entity_id);
      if (!old_state || !new_state || old_state.state === new_state.state) return; // attribute-only change
      this.emit('event', {
        source: 'homeassistant',
        type: 'state',
        entity: entity_id,
        name: new_state.attributes?.friendly_name ?? entity_id,
        from: old_state.state,
        to: new_state.state,
        at: new Date().toISOString(),
      });
    }
  }

  async refreshStates() {
    const list = await fetchJson(`${this.cfg.url}/api/states`, { headers: this.#headers() });
    this.states = new Map(list.map((s) => [s.entity_id, s]));
    this.status.entities = this.states.size;
  }

  entities(query = '', domain = '') {
    const q = query.toLowerCase();
    return [...this.states.values()]
      .filter((s) => (!domain || s.entity_id.startsWith(`${domain}.`)) && (!q || `${s.entity_id} ${s.attributes?.friendly_name ?? ''}`.toLowerCase().includes(q)))
      .map((s) => ({ entity_id: s.entity_id, name: s.attributes?.friendly_name ?? s.entity_id, state: s.state }));
  }

  async callService(service, data = {}) {
    if (!this.ready) throw new Error('Home Assistant is not connected');
    const [domain, name] = String(service).split('.');
    if (!domain || !name) throw new Error(`Service should look like "light.turn_on", got "${service}"`);
    return fetchJson(`${this.cfg.url}/api/services/${domain}/${name}`, { method: 'POST', headers: this.#headers(), body: JSON.stringify(data) });
  }

  // ---------- light driver interface ----------

  async list() {
    if (!this.status.connected) return [];
    return this.entities('', 'light').map((e) => ({ id: `ha:${e.entity_id}`, name: e.name, kind: 'ha-light', on: e.state === 'on' }));
  }

  async apply(entityId, params, transitionMs = 0) {
    const off = params.on === false || params.brightness === 0;
    const data = { entity_id: entityId };
    if (transitionMs) data.transition = transitionMs / 1000;
    if (off) return this.callService('light.turn_off', data);
    if (params.brightness != null) data.brightness_pct = clamp(Math.round(params.brightness), 1, 100);
    if (params.kelvin) data.color_temp_kelvin = params.kelvin;
    else if (params.color) {
      const rgb = hexToRgb(params.color);
      if (rgb) data.rgb_color = [rgb.r, rgb.g, rgb.b];
    }
    return this.callService('light.turn_on', data);
  }

  async getState(entityId) {
    const s = this.states.get(entityId);
    if (!s) return null;
    return {
      on: s.state === 'on',
      brightness: Math.round(((s.attributes?.brightness ?? 255) / 255) * 100),
      ...(s.attributes?.color_temp_kelvin ? { kelvin: s.attributes.color_temp_kelvin } : {}),
    };
  }
}
