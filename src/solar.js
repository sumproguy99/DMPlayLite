// Offline sunrise/sunset and moon phase (algorithms after NOAA / SunCalc). No API needed.
const rad = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = rad * 23.4397;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);

// Sun times for the local calendar day containing `date`. Null fields during polar day/night.
export function sunTimes(date, lat, lon) {
  const noonLocal = new Date(date);
  noonLocal.setHours(12, 0, 0, 0);
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toJulian(noonLocal) - J2000;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = rad * (357.5291 + 0.98560028 * ds);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const at = (altitudeDeg) => {
    const w = Math.acos((Math.sin(rad * altitudeDeg) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    if (Number.isNaN(w)) return [null, null];
    const Jset = J2000 + J0 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
  };
  const [sunrise, sunset] = at(-0.833);
  const [dawn, dusk] = at(-6); // civil twilight
  return { sunrise, sunset, dawn, dusk, noon: fromJulian(Jnoon) };
}

export function isDark(now, lat, lon) {
  const { sunrise, sunset } = sunTimes(now, lat, lon);
  if (!sunrise || !sunset) return false;
  return now < sunrise || now > sunset;
}

// 0 = new moon, 0.5 = full moon.
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const days = toJulian(date) - 2451550.1;
  return (((days / synodic) % 1) + 1) % 1;
}

export function moonName(phase) {
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return names[Math.round(phase * 8) % 8];
}

// Full moon "night": within ~1 day of exact full.
export const isFullMoon = (date = new Date()) => Math.abs(moonPhase(date) - 0.5) < 0.034;
