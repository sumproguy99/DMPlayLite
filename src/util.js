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

export const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('')}`;

// Approximate RGB of a white color temperature (Tanner Helland's fit), for lights without a white channel.
export function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return { r: Math.round(clamp(r, 0, 255)), g: Math.round(clamp(g, 0, 255)), b: Math.round(clamp(b, 0, 255)) };
}

// CIE xy -> sRGB hex at full brightness (inverse of rgbToXy), for reading a Hue light's color back.
export function xyToHex([x, y]) {
  if (!y) return '#ffffff';
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  const rgb = [
    X * 1.656492 - Y * 0.354851 - Z * 0.255038,
    -X * 0.707196 + Y * 1.655397 + Z * 0.036152,
    X * 0.051713 - Y * 0.121364 + Z * 1.01153,
  ].map((c) => Math.max(0, c));
  const max = Math.max(...rgb) || 1;
  const [r, g, b] = rgb.map((c) => {
    c /= max;
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  });
  return rgbToHex({ r, g, b });
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
