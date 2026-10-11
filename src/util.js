// Small shared helpers: cancellation, timing, color math.

export class Token {
  cancelled = false;
  #callbacks = new Set();

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of this.#callbacks) cb();
    this.#callbacks.clear();
  }

  onCancel(cb) {
    if (this.cancelled) {
      cb();
      return () => {};
    }
    this.#callbacks.add(cb);
    return () => this.#callbacks.delete(cb);
  }
}

// Resolves after `ms`, or early if the token is cancelled.
export function sleep(ms, token) {
  return new Promise((resolve) => {
    if (token?.cancelled || ms <= 0) return resolve();
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
    if (token) {
      off = token.onCancel(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const contains = (haystack, needle) =>
  String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());

export function kelvinToMired(kelvin) {
  return clamp(Math.round(1_000_000 / kelvin), 153, 500);
}

export function miredToKelvin(mired) {
  return Math.round(1_000_000 / mired);
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// sRGB -> CIE xy using the Philips Hue wide-gamut conversion.
export function rgbToXy({ r, g, b }) {
  const lin = (c) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329];
  return [+(X / sum).toFixed(4), +(Y / sum).toFixed(4)];
}

// Expands pulse levels into a flat brightness sequence, dropping
// back-to-back duplicates so [100,70,100] x2 => 100,70,100,70,100.
export function pulseSequence(levels, times) {
  const out = [];
  for (let i = 0; i < times; i++) {
    for (const level of levels) {
      if (out.at(-1) !== level) out.push(level);
    }
  }
  return out;
}

export function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fetchJson(url, { timeoutMs = 5000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${redact(url)} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export function redact(url) {
  return String(url).replace(/(X-Plex-Token=)[^&]+/i, '$1***').replace(/(\/api\/)[A-Za-z0-9-]{20,}/, '$1***');
}
