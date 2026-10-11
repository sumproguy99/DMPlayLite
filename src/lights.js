// Unified light control across drivers.
// Target ids:  hue:light:<n>  hue:group:<n>  govee:<deviceId>  group:<playliteGroupId>
//
// Every target has at most one "owner" at a time. When a new routine claims a
// light, any fade or pulse still running on it from an earlier routine stops,
// so pressing pause mid-fade immediately takes over.
import { Token, pulseSequence, sleep } from './util.js';

const SOFT_FADE_STEP_MS = 150;

export class LightController {
  #owners = new Map(); // target -> Token
  #cache = new Map(); // target -> last commanded state

  constructor({ drivers, getConfig, log }) {
    this.drivers = drivers; // { hue, govee }
    this.getConfig = getConfig;
    this.log = log;
  }

  async list() {
    const out = [];
    for (const [name, driver] of Object.entries(this.drivers)) {
      try {
        out.push(...(await driver.list()));
      } catch (err) {
        this.log.warn(`Could not list ${name} lights: ${err.message}`);
      }
    }
    return out;
  }

  // Expands Playlite groups into concrete device targets.
  resolve(ids, seen = new Set()) {
    const out = new Set();
    for (const id of ids ?? []) {
      if (id.startsWith('group:')) {
        const gid = id.slice(6);
        if (seen.has(gid)) continue;
        seen.add(gid);
        const group = this.getConfig().groups.find((g) => g.id === gid);
        if (!group) this.log.warn(`Unknown group "${gid}"`);
        for (const t of this.resolve(group?.members, seen)) out.add(t);
      } else {
        out.add(id);
      }
    }
    return [...out];
  }

  #driver(target) {
    const i = target.indexOf(':');
    const driver = this.drivers[target.slice(0, i)];
    if (!driver) throw new Error(`No driver for ${target}`);
    return { driver, ref: target.slice(i + 1) };
  }

  // Take ownership of targets, cancelling whatever else was driving them.
  claim(targets) {
    const tokens = new Map();
    for (const t of targets) {
      this.#owners.get(t)?.cancel();
      const token = new Token();
      this.#owners.set(t, token);
      tokens.set(t, token);
    }
    return tokens;
  }

  release(tokens) {
    for (const [t, token] of tokens) {
      if (this.#owners.get(t) === token) this.#owners.delete(t);
    }
  }

  async getState(target) {
    const { driver, ref } = this.#driver(target);
    try {
      const live = await driver.getState(ref);
      if (live) return live;
    } catch {
      // fall through to cache
    }
    return this.#cache.get(target) ?? null;
  }

  #remember(target, params) {
    const prev = this.#cache.get(target) ?? {};
    const next = { ...prev, ...params };
    if (params.brightness === 0 || params.on === false) next.on = false;
    else if (params.brightness != null) next.on = true;
    if (params.kelvin) delete next.color;
    if (params.color) delete next.kelvin;
    this.#cache.set(target, next);
  }

  // Set state, optionally fading over transitionMs. Resolves when the fade finishes.
  async set(target, params, transitionMs = 0, token = new Token()) {
    if (token.cancelled) return;
    const { driver, ref } = this.#driver(target);

    if (driver.supportsTransition || !transitionMs || params.brightness == null) {
      await driver.apply(ref, params, transitionMs);
      this.#remember(target, params);
      await sleep(transitionMs, token);
      return;
    }

    // Software fade for drivers without native transitions (Govee).
    const prev = this.#cache.get(target) ?? (await driver.getState(ref).catch(() => null));
    const start = prev?.on === false ? 0 : (prev?.brightness ?? params.brightness);
    const end = params.on === false ? 0 : params.brightness;
    const { brightness, ...rest } = params;

    if (end > 0) {
      await driver.apply(ref, { ...rest, on: true, brightness: Math.max(1, start) });
    } else if (rest.kelvin || rest.color) {
      await driver.apply(ref, rest);
    }

    const steps = Math.max(1, Math.round(transitionMs / SOFT_FADE_STEP_MS));
    let last = start;
    for (let i = 1; i <= steps; i++) {
      await sleep(transitionMs / steps, token);
      if (token.cancelled) return;
      const b = Math.round(start + ((end - start) * i) / steps);
      if (b !== last && b > 0) {
        await driver.setBrightness(ref, b);
        this.#remember(target, { brightness: b });
      }
      last = b;
    }
    if (end === 0) await driver.apply(ref, { on: false });
    this.#remember(target, { ...rest, brightness: end });
  }

  async pulse(target, { levels = [100, 70, 100], times = 5, stepMs = 1000, restore = false }, token = new Token()) {
    const before = restore ? await this.getState(target) : null;
    for (const level of pulseSequence(levels, times)) {
      if (token.cancelled) return;
      await this.set(target, { brightness: level }, stepMs, token);
    }
    if (before && !token.cancelled) {
      const { on, brightness, kelvin, color } = before;
      await this.set(target, on === false ? { on: false } : { brightness, kelvin, color }, stepMs, token);
    }
  }

  // Quick blink so you can tell which physical light an id refers to.
  async identify(target) {
    const tokens = this.claim([target]);
    try {
      await this.pulse(target, { levels: [100, 20, 100], times: 2, stepMs: 400, restore: true }, tokens.get(target));
    } finally {
      this.release(tokens);
    }
  }
}
