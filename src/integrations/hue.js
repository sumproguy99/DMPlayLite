// Philips Hue bridge driver (local REST API v1, plain HTTP on the LAN).
// The bridge performs transitions natively, so fades are perfectly smooth.
import { clamp, fetchJson, hexToRgb, kelvinToMired, miredToKelvin, rgbToXy, sleep, xyToHex } from '../util.js';

export class HueDriver {
  supportsTransition = true;

  constructor(getConfig, log) {
    this.getConfig = getConfig;
    this.log = log;
    this.queue = Promise.resolve();
  }

  get cfg() { return this.getConfig().hue; }
  get ready() { return Boolean(this.cfg.bridgeIp && this.cfg.username); }
  base() { return `http://${this.cfg.bridgeIp}/api/${this.cfg.username}`; }

  // The bridge chokes above ~10 commands/sec; serialize with a small gap.
  #throttled(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {}).then(() => sleep(60));
    return run;
  }

  async discover() {
    const found = await fetchJson('https://discovery.meethue.com/', { timeoutMs: 6000 }).catch(() => []);
    return (found ?? []).map((b) => ({ id: b.id, ip: b.internalipaddress }));
  }

  // Requires the physical link button on the bridge to have been pressed within 30s.
  async pair(ip) {
    const res = await fetchJson(`http://${ip}/api`, {
      method: 'POST',
      body: JSON.stringify({ devicetype: 'playlite#server' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const item = res?.[0];
    if (item?.success?.username) return item.success.username;
    if (item?.error?.type === 101) throw new Error('Press the round link button on the Hue bridge, then click Pair within 30 seconds.');
    throw new Error(item?.error?.description ?? 'Unexpected response from bridge');
  }

  async list() {
    if (!this.ready) return [];
    const [lights, groups] = await Promise.all([
      fetchJson(`${this.base()}/lights`),
      fetchJson(`${this.base()}/groups`),
    ]);
    if (Array.isArray(lights) && lights[0]?.error) throw new Error(lights[0].error.description);
    const out = [];
    for (const [id, g] of Object.entries(groups ?? {})) {
      if (!['Room', 'Zone', 'LightGroup', 'Entertainment'].includes(g.type)) continue;
      out.push({ id: `hue:group:${id}`, name: `${g.name} (${g.type === 'Zone' ? 'zone' : 'room'})`, kind: 'hue-group', on: g.state?.any_on });
    }
    for (const [id, l] of Object.entries(lights ?? {})) {
      out.push({ id: `hue:light:${id}`, name: l.name, kind: 'hue-light', on: l.state?.on, reachable: l.state?.reachable });
    }
    return out;
  }

  #path(ref) {
    const [kind, id] = ref.split(':');
    return kind === 'group' ? `${this.base()}/groups/${id}/action` : `${this.base()}/lights/${id}/state`;
  }

  async apply(ref, params, transitionMs = 0) {
    if (!this.ready) throw new Error('Hue bridge not paired');
    const body = { transitiontime: Math.round(transitionMs / 100) };
    if (params.brightness != null) {
      if (params.brightness <= 0) body.on = false;
      else {
        body.on = true;
        body.bri = clamp(Math.round(params.brightness * 2.54), 1, 254);
      }
    }
    if (params.on != null) body.on = params.on;
    if (params.kelvin) body.ct = kelvinToMired(params.kelvin);
    else if (params.color) {
      const rgb = hexToRgb(params.color);
      if (rgb) body.xy = rgbToXy(rgb);
    }
    const res = await this.#throttled(() =>
      fetchJson(this.#path(ref), { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    );
    const err = res?.find?.((r) => r.error);
    if (err) throw new Error(`Hue: ${err.error.description}`);
  }

  async getState(ref) {
    const [kind, id] = ref.split(':');
    const data = await fetchJson(kind === 'group' ? `${this.base()}/groups/${id}` : `${this.base()}/lights/${id}`);
    const s = kind === 'group' ? data.action : data.state;
    const on = kind === 'group' ? data.state?.any_on : s.on;
    return {
      on,
      brightness: Math.round((s.bri ?? 254) / 2.54),
      ...(s.colormode === 'ct' && s.ct ? { kelvin: miredToKelvin(s.ct) } : {}),
      ...((s.colormode === 'xy' || s.colormode === 'hs') && s.xy ? { color: xyToHex(s.xy) } : {}),
    };
  }
}
