// Roku External Control Protocol (ECP): plain HTTP on port 8060, no account.
//   POST http://<roku>:8060/keypress/<Key>   — remote buttons (Play toggles play/pause)
//   POST http://<roku>:8060/launch/<appId>   — open a channel
// Rokus are found by network discovery. Newer firmware needs Settings → System → Advanced system settings →
// Control by mobile apps → Network access = "Default" or "Permissive".

export const ROKU_KEYS = [
  ['Play', 'Play / pause'], ['Home', 'Home'], ['Back', 'Back'], ['Select', 'OK'], ['Rev', 'Rewind'], ['Fwd', 'Fast-forward'],
  ['InstantReplay', 'Instant replay'], ['VolumeUp', 'Volume up'], ['VolumeDown', 'Volume down'], ['VolumeMute', 'Mute'],
  ['PowerOff', 'Power off (Roku TV)'], ['PowerOn', 'Power on (Roku TV)'],
];
export const ROKU_APPS = { plex: 13535, netflix: 12, youtube: 837, 'disney+': 291097, hulu: 2285, 'prime video': 13, max: 61322, spotify: 22297 };

export class Roku {
  constructor({ discovery, log, port = 8060 }) {
    this.discovery = discovery;
    this.log = log;
    this.port = port;
  }

  devices() {
    return (this.discovery?.list() ?? []).filter((d) => d.kind === 'roku').map((d) => ({ name: d.name ?? d.ip, ip: d.ip, online: d.online }));
  }

  // A device name (contains), or an IP / host[:port].
  resolve(device) {
    const q = String(device ?? '').trim();
    if (/^[\d.]+(:\d+)?$/.test(q)) return q.includes(':') ? q : `${q}:${this.port}`;
    const all = this.devices();
    const match = q ? all.filter((d) => d.name.toLowerCase().includes(q.toLowerCase())) : all;
    if (!match.length) throw new Error(q ? `No Roku called "${q}" found on the network` : 'No Roku found on the network');
    if (!q && match.length > 1) throw new Error(`${match.length} Rokus found (${match.map((d) => d.name).join(', ')}) — say which one`);
    return `${match[0].ip}:${this.port}`;
  }

  async #post(host, path) {
    const res = await fetch(`http://${host}${path}`, { method: 'POST', signal: AbortSignal.timeout(4000) }).catch((err) => {
      throw new Error(`can't reach the Roku at ${host} (${err.cause?.code ?? err.message})`);
    });
    if (res.status === 403) throw new Error('the Roku refused — turn on Settings → System → Advanced system settings → Control by mobile apps');
    if (!res.ok) throw new Error(`the Roku answered HTTP ${res.status}`);
  }

  async keypress(device, key) {
    if (!ROKU_KEYS.some(([k]) => k === key)) throw new Error(`Unknown Roku button "${key}"`);
    await this.#post(this.resolve(device), `/keypress/${key}`);
  }

  async launch(device, app) {
    const id = ROKU_APPS[String(app).toLowerCase()] ?? (/^\d+$/.test(String(app)) ? app : null);
    if (!id) throw new Error(`Unknown Roku app "${app}" — use ${Object.keys(ROKU_APPS).join(', ')} or a numeric channel id`);
    await this.#post(this.resolve(device), `/launch/${id}`);
  }
}
