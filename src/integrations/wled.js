// WLED driver (LED strips on ESP8266/ESP32) — local JSON API, plain HTTP on the LAN.
//   GET  http://<ip>/json/info   -> name, mac, version, LED count
//   GET  http://<ip>/json/state  -> on, bri 0-255, segments with colors
//   POST http://<ip>/json/state  -> { on, bri, transition (×100 ms), seg: { col, fx } }
// WLED fades natively. Devices are found by network discovery (mDNS _wled._tcp) or added by IP.
import { clamp, fetchJson, hexToRgb, kelvinToRgb, rgbToHex } from '../util.js';

export class WledDriver {
  supportsTransition = true;

  constructor(getConfig, updateConfig, log) {
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.log = log;
  }

  get devices() { return this.getConfig().wled?.devices ?? {}; }

  #ip(ref) {
    const ip = this.devices[ref]?.ip;
    if (!ip) throw new Error(`Unknown WLED device ${ref}`);
    return ip;
  }

  async info(ip) {
    const info = await fetchJson(`http://${ip}/json/info`, { timeoutMs: 3000 }).catch(() => null);
    if (!info?.ver) throw new Error(`No WLED device answered at ${ip}`);
    return info;
  }

  async add(ip) {
    ip = String(ip ?? '').trim();
    if (!/^[\w.-]+(:\d+)?$/.test(ip)) throw new Error('Enter the IP address (or hostname) of the WLED device');
    const info = await this.info(ip);
    const id = (info.mac || ip).replace(/[^\w]/g, '').toLowerCase();
    this.updateConfig((c) => {
      c.wled ??= { devices: {} };
      c.wled.devices[id] = { ...c.wled.devices[id], name: c.wled.devices[id]?.name ?? info.name ?? `WLED ${ip}`, ip, leds: info.leds?.count };
    });
    this.log.info(`WLED: added ${this.devices[id].name} (${ip}, ${info.leds?.count ?? '?'} LEDs, v${info.ver})`);
    return id;
  }

  remove(id) {
    this.updateConfig((c) => delete c.wled?.devices?.[id]);
  }

  rename(id, name) {
    if (!this.devices[id]) throw new Error('Unknown WLED device');
    this.updateConfig((c) => (c.wled.devices[id].name = String(name).trim() || c.wled.devices[id].name));
  }

  // ---------- light driver interface ----------

  async list() {
    return Object.entries(this.devices).map(([id, d]) => ({ id: `wled:${id}`, name: d.name, kind: 'wled', ip: d.ip }));
  }

  async getState(ref) {
    const s = await fetchJson(`http://${this.#ip(ref)}/json/state`, { timeoutMs: 3000 });
    const col = s?.seg?.[0]?.col?.[0];
    return {
      on: Boolean(s.on),
      brightness: Math.round((s.bri ?? 255) / 2.55),
      ...(col?.length >= 3 ? { color: rgbToHex({ r: col[0], g: col[1], b: col[2] }) } : {}),
    };
  }

  async apply(ref, params, transitionMs = 0) {
    const body = { transition: clamp(Math.round(transitionMs / 100), 0, 65535) };
    if (params.brightness != null) {
      if (params.brightness <= 0) body.on = false;
      else {
        body.on = true;
        body.bri = clamp(Math.round(params.brightness * 2.55), 1, 255);
      }
    }
    if (params.on != null && body.on == null) body.on = params.on;
    const rgb = params.kelvin ? kelvinToRgb(params.kelvin) : params.color ? hexToRgb(params.color) : null;
    // A color means a solid color, so switch off any running effect (fx 0 = Solid). cct is used by RGBW/CCT strips.
    if (rgb) body.seg = { col: [[rgb.r, rgb.g, rgb.b]], fx: 0, ...(params.kelvin ? { cct: clamp(params.kelvin, 1900, 10091) } : {}) };
    const res = await fetchJson(`http://${this.#ip(ref)}/json/state`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 3000,
    });
    if (res && res.success === false) throw new Error('WLED rejected the command');
  }
}
