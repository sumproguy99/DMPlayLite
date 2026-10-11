// Always-on network discovery.
//
// Every cycle (default 60 s):
//   1. mDNS / Bonjour  — asks "who offers what?" (Chromecast, AirPlay, HomeKit, Hue, WLED,
//                         Home Assistant, ESPHome, Shelly, Sonos, printers, iPhones/Macs…)
//   2. SSDP / UPnP     — routers, Roku, smart TVs, Sonos, media servers, Hue bridges
//   3. Liveness probe  — quick TCP knock on every known device (a refusal still means "home")
//   4. Neighbor table  — ARP/NDP gives MAC addresses of everything that answered
// Every 10 min it also sweeps the whole subnet so quiet devices get found too.
//
// Emits engine events: network/device.new · device.online · device.offline
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { encodeQuery, decodePacket, TYPE } from './dns.js';
import { neighborTable, primaryIp, subnetHosts, tcpAlive } from './net.js';

const MDNS_ADDR = '224.0.0.251';
const SSDP_ADDR = '239.255.255.250';

const MDNS_TYPES = [
  '_services._dns-sd._udp.local', '_googlecast._tcp.local', '_airplay._tcp.local', '_raop._tcp.local',
  '_companion-link._tcp.local', '_hap._tcp.local', '_hue._tcp.local', '_wled._tcp.local',
  '_home-assistant._tcp.local', '_esphomelib._tcp.local', '_shelly._tcp.local', '_sonos._tcp.local',
  '_spotify-connect._tcp.local', '_plexmediasvr._tcp.local', '_ipp._tcp.local', '_printer._tcp.local',
  '_matter._tcp.local', '_nanoleafapi._tcp.local', '_elg._tcp.local', '_amzn-wplay._tcp.local',
  '_androidtvremote2._tcp.local', '_smb._tcp.local', '_ssh._tcp.local', '_http._tcp.local', '_workstation._tcp.local',
];

// What a service type tells us about the device. First match wins (ordered by specificity).
const SERVICE_KINDS = [
  ['_home-assistant', 'home-assistant', 'Home Assistant'],
  ['_hue', 'hue-bridge', 'Philips Hue Bridge'],
  ['_wled', 'wled', 'WLED light'],
  ['_plexmediasvr', 'plex-server', 'Plex Media Server'],
  ['_googlecast', 'chromecast', 'Google Cast device'],
  ['_amzn-wplay', 'fire-tv', 'Amazon Fire TV / Echo'],
  ['_androidtvremote2', 'android-tv', 'Android / Google TV'],
  ['_sonos', 'sonos', 'Sonos speaker'],
  ['_esphomelib', 'esphome', 'ESPHome device'],
  ['_shelly', 'shelly', 'Shelly device'],
  ['_nanoleafapi', 'nanoleaf', 'Nanoleaf'],
  ['_elg', 'elgato', 'Elgato light'],
  ['_matter', 'matter', 'Matter device'],
  ['_hap', 'homekit', 'HomeKit accessory'],
  ['_companion-link', 'apple', 'Apple device (iPhone / iPad / Mac)'],
  ['_airplay', 'airplay', 'AirPlay device'],
  ['_raop', 'airplay', 'AirPlay speaker'],
  ['_spotify-connect', 'speaker', 'Spotify Connect speaker'],
  ['_ipp', 'printer', 'Printer'],
  ['_printer', 'printer', 'Printer'],
  ['_smb', 'computer', 'Computer / NAS'],
  ['_workstation', 'computer', 'Computer'],
  ['_ssh', 'computer', 'Computer / server'],
];

const SSDP_KINDS = [
  [/IpBridge|hue/i, 'hue-bridge', 'Philips Hue Bridge'],
  [/roku/i, 'roku', 'Roku'],
  [/ZonePlayer|sonos/i, 'sonos', 'Sonos speaker'],
  [/InternetGatewayDevice|WANDevice/i, 'router', 'Router'],
  [/plex/i, 'plex-server', 'Plex Media Server'],
  [/samsung|tizen/i, 'tv', 'Samsung TV'],
  [/webos|LG Electronics/i, 'tv', 'LG TV'],
  [/dial-multiscreen|MediaRenderer/i, 'tv', 'TV / media player'],
  [/amazon/i, 'fire-tv', 'Amazon device'],
  [/MediaServer/i, 'media-server', 'Media server / NAS'],
];

// Hostname / name patterns many devices use when they register with your router's DHCP.
const HOST_KINDS = [
  [/^RE\d{3}|extender|repeater|\bdeco\b|eero|orbi|mesh/i, 'router', 'Wi-Fi extender / mesh point'],
  [/wyze|hl_cam|hl_pan|hl_doorbell|reolink|arlo|blink|eufy|amcrest|hikvision|\bcam(era)?\b|_cam/i, 'camera', 'Camera'],
  [/doorbell|\bring-/i, 'doorbell', 'Doorbell'],
  [/tstat|thermostat|ecobee|nest-?(learning|thermostat)|honeywell|resideo|sensi/i, 'thermostat', 'Thermostat'],
  [/^amazon-|echo|kindle|fire-?tv/i, 'echo', 'Amazon Echo / Fire device'],
  [/google-?home|google-?nest|chromecast|nest-?(hub|mini|audio)/i, 'google', 'Google / Nest device'],
  [/iphone/i, 'phone', 'iPhone'],
  [/ipad|tablet/i, 'tablet', 'Tablet'],
  [/android|galaxy|pixel|oneplus|phone/i, 'phone', 'Phone'],
  [/roku/i, 'roku', 'Roku'],
  [/sonos/i, 'sonos', 'Sonos speaker'],
  [/bravia|samsung|lgwebos|webos|vizio|tcl|hisense|\btv\b/i, 'tv', 'TV'],
  [/xbox|playstation|ps[45]|nintendo|switch/i, 'console', 'Game console'],
  [/tasmota|shelly|wled|esp[-_]|espressif|tuya|smartplug|kasa|tapo|hs1\d\d|wemo|meross|govee|ihost/i, 'iot', 'Smart plug / IoT device'],
  [/myq|liftmaster|chamberlain/i, 'garage', 'Garage door opener'],
  [/desktop|laptop|-pc\b|macbook|imac|\bnas\b|synology|qnap|-pi\b|raspberry/i, 'computer', 'Computer / server'],
  [/printer|canon|epson|brother|hp[0-9a-f]{6}/i, 'printer', 'Printer'],
];

// A few common hardware vendors by MAC prefix (OUI).
const OUI = {
  '00:17:88': 'Philips Hue', 'ec:b5:fa': 'Philips Hue', 'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi', 'd8:3a:dd': 'Raspberry Pi', '2c:cf:67': 'Raspberry Pi', '00:0e:58': 'Sonos',
  '48:a6:b8': 'Sonos', '5c:aa:fd': 'Sonos', '94:9f:3e': 'Sonos', 'b8:e9:37': 'Sonos', '78:28:ca': 'Sonos',
  '54:2a:1b': 'Sonos', 'b0:a7:37': 'Roku', 'd8:31:34': 'Roku', 'cc:6d:a0': 'Roku', 'ac:3a:7a': 'Roku',
  '08:05:81': 'Roku', 'dc:3a:5e': 'Roku', '24:5a:4c': 'Ubiquiti', '74:83:c2': 'Ubiquiti', '78:8a:20': 'Ubiquiti',
  'f0:9f:c2': 'Ubiquiti', 'fc:ec:da': 'Ubiquiti', 'e0:63:da': 'Ubiquiti', '68:d7:9a': 'Ubiquiti',
  '44:65:0d': 'Amazon', '74:c2:46': 'Amazon', 'f0:27:2d': 'Amazon', '68:54:fd': 'Amazon', 'fc:65:de': 'Amazon',
  '0c:47:c9': 'Amazon', '84:d6:d0': 'Amazon', '40:b4:cd': 'Amazon', '50:dc:e7': 'Amazon', '38:f7:3d': 'Amazon',
  'f4:f5:d8': 'Google', 'f4:f5:e8': 'Google', '54:60:09': 'Google', '1c:f2:9a': 'Google', '30:fd:38': 'Google',
  '48:d6:d5': 'Google', 'a4:77:33': 'Google', '20:df:b9': 'Google', 'd8:6c:63': 'Google', '3c:5a:b4': 'Google',
  '24:0a:c4': 'Espressif (smart device)', '30:ae:a4': 'Espressif (smart device)', 'a4:cf:12': 'Espressif (smart device)',
  '84:cc:a8': 'Espressif (smart device)', '24:6f:28': 'Espressif (smart device)', '7c:9e:bd': 'Espressif (smart device)',
  'c8:2b:96': 'Espressif (smart device)', 'e8:db:84': 'Espressif (smart device)', '8c:aa:b5': 'Espressif (smart device)',
  '10:52:1c': 'Espressif (smart device)', '3c:61:05': 'Espressif (smart device)', 'cc:50:e3': 'Espressif (smart device)',
  '48:3f:da': 'Espressif (smart device)', '34:94:54': 'Espressif (smart device)', '08:3a:f2': 'Espressif (smart device)',
  '40:22:d8': 'Espressif (smart device)', 'd4:8a:fc': 'Espressif (smart device)', '98:cd:ac': 'Espressif (smart device)',
  '60:01:94': 'Espressif (smart device)', 'ec:fa:bc': 'Espressif (smart device)', 'bc:dd:c2': 'Espressif (smart device)',
  '5c:cf:7f': 'Espressif (smart device)', '2c:3a:e8': 'Espressif (smart device)', 'a0:20:a6': 'Espressif (smart device)',
};

export function vendorFor(mac) {
  if (!mac) return null;
  const known = OUI[mac.slice(0, 8)];
  if (known) return known;
  // Locally-administered bit => randomized "private Wi-Fi address", almost always a phone/tablet/laptop.
  if (parseInt(mac.slice(0, 2), 16) & 0x02) return 'Private address (phone / tablet / laptop)';
  return null;
}

export function classify(device) {
  for (const [prefix, kind, label] of SERVICE_KINDS) {
    if (device.services?.some((s) => s.startsWith(prefix))) return { kind, label };
  }
  const ssdp = [device.ssdp?.server, device.ssdp?.st, device.ssdp?.manufacturer, device.ssdp?.model].join(' ');
  for (const [re, kind, label] of SSDP_KINDS) if (re.test(ssdp)) return { kind, label };
  if (device.govee) return { kind: 'govee', label: 'Govee light' };
  const v = device.vendor ?? '';
  if (v.startsWith('Private')) return { kind: 'phone', label: 'Phone / tablet / laptop' };
  if (v === 'Philips Hue') return { kind: 'hue-bridge', label: 'Philips Hue' };
  if (v === 'Amazon') return { kind: 'echo', label: 'Amazon Echo / Fire device' };
  if (v === 'Google') return { kind: 'google', label: 'Google / Nest device' };
  if (v.startsWith('Espressif')) return { kind: 'iot', label: 'Smart-home gadget (ESP chip)' };
  const host = `${device.hostname ?? ''} ${device.name ?? ''}`;
  for (const [re, kind, label] of HOST_KINDS) if (re.test(host)) return { kind, label };
  if (/\.(1|254)$/.test(device.ip ?? '')) return { kind: 'router', label: 'Router / gateway' };
  return { kind: 'unknown', label: v || 'Unknown device' };
}

// Best display name: explicit friendly name > most specific service's instance name > UPnP > hostname.
export function pickName(d) {
  if (d.customName) return d.customName;
  const names = d.names ?? {};
  if (names._friendly) return names._friendly;
  for (const [prefix] of SERVICE_KINDS) {
    const hit = Object.entries(names).find(([svc]) => svc.startsWith(prefix));
    if (hit) return hit[1];
  }
  const any = Object.entries(names).find(([svc]) => !/_spotify|_http/.test(svc));
  return any?.[1] ?? d.ssdp?.friendlyName ?? d.hostname ?? names['_spotify-connect._tcp'] ?? null;
}

export class Discovery extends EventEmitter {
  devices = new Map(); // key (mac or ip:x.x.x.x) -> device
  status = { running: false, lastCycle: null, lastSweep: null, cycles: 0 };
  #timer = null;
  #baseline = false; // true once we have a saved inventory, so "new device" alerts are meaningful
  #warm = false;
  #saveTimer = null;
  #descCache = new Map();
  #sharedMacs = new Set();

  constructor({ dataDir, log, intervalSec = 60, offlineAfterMin = 10, sweepEveryMin = 10 }) {
    super();
    this.file = path.join(dataDir, 'devices.json');
    this.log = log;
    this.intervalSec = intervalSec;
    this.offlineAfterMs = offlineAfterMin * 60_000;
    this.sweepEveryMs = sweepEveryMin * 60_000;
    this.#load();
  }

  #load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const d of saved.devices ?? []) this.devices.set(d.key, { ...d, online: false });
      this.#baseline = true;
    } catch {
      this.#baseline = false;
    }
  }

  #save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      const devices = [...this.devices.values()].map(({ online, ...d }) => d);
      fs.writeFile(this.file, JSON.stringify({ devices }, null, 1), () => {});
    }, 2000);
  }

  persist() {
    this.#save();
  }

  start() {
    if (this.status.running) return;
    this.status.running = true;
    const loop = async () => {
      try {
        await this.cycle();
      } catch (err) {
        this.log.warn(`Discovery cycle failed: ${err.message}`);
      }
      if (this.status.running) this.#timer = setTimeout(loop, this.intervalSec * 1000);
    };
    loop();
  }

  stop() {
    this.status.running = false;
    clearTimeout(this.#timer);
  }

  // Online first, then identified devices, then by name (unnamed ones by IP).
  list() {
    const ipNum = (ip) => ip?.split('.').reduce((n, o) => n * 256 + Number(o), 0) ?? 0;
    return [...this.devices.values()].sort((a, b) =>
      (b.online - a.online)
      || ((a.kind === 'unknown') - (b.kind === 'unknown'))
      || (!a.name - !b.name)
      || (a.name ?? '').localeCompare(b.name ?? '')
      || ipNum(a.ip) - ipNum(b.ip));
  }

  find(query) {
    const q = String(query).toLowerCase();
    return this.list().filter((d) => [d.name, d.hostname, d.ip, d.mac, d.kind, d.label, d.vendor].some((v) => String(v ?? '').toLowerCase().includes(q)));
  }

  // Let other integrations (e.g. Govee) report what they found.
  report(ip, patch) {
    this.#touch(ip, patch, new Map());
  }

  async cycle() {
    const seen = new Map(); // ip -> patch
    const sweep = !this.status.lastSweep || Date.now() - Date.parse(this.status.lastSweep) > this.sweepEveryMs;

    await Promise.all([this.#mdns(seen), this.#ssdp(seen)]);

    // Probe: every known IP each cycle; the whole subnet on sweep cycles.
    const targets = new Set([...this.devices.values()].map((d) => d.ip).filter(Boolean));
    if (sweep) for (const ip of subnetHosts()) targets.add(ip);
    for (const ip of seen.keys()) targets.delete(ip);
    const alive = await pool([...targets], 64, async (ip) => ((await tcpAlive(ip)) ? ip : null));
    for (const ip of alive) if (ip) seen.set(ip, { ...seen.get(ip) });

    const neighbors = await neighborTable();
    for (const [ip, n] of neighbors) if (n.reachable && !seen.has(ip)) seen.set(ip, {});
    // Wi-Fi extenders with MAC translation answer for every device behind them with ONE MAC.
    // Those MACs can't identify a device, so such devices are tracked per IP instead.
    const count = new Map();
    for (const n of neighbors.values()) count.set(n.mac, (count.get(n.mac) ?? 0) + 1);
    this.#sharedMacs = new Set([...count].filter(([, c]) => c > 1).map(([m]) => m));

    const self = primaryIp();
    const onLan = new Set(subnetHosts()); // ignore VPN / virtual-switch neighbors
    for (const [ip, patch] of seen) if (ip !== self && onLan.has(ip)) this.#touch(ip, patch, neighbors);

    // Resolve hostnames (your router's DNS usually knows them) for anything still nameless.
    await Promise.race([
      Promise.all([...this.devices.values()].filter((d) => d.online && !d.hostname && !d.lookedUp).map(async (d) => {
        d.lookedUp = true;
        const [h] = await dns.reverse(d.ip).catch(() => []);
        if (h) d.hostname = h.replace(/\.(lan|local|home|localdomain)$/i, '');
        d.name = pickName(d);
        Object.assign(d, classify(d));
      })),
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    this.#checkOffline();
    if (sweep) this.status.lastSweep = new Date().toISOString();
    this.status.lastCycle = new Date().toISOString();
    this.status.cycles++;
    if (!this.#warm) {
      this.#warm = true;
      this.#baseline = true;
      this.log.info(`Discovery: ${[...this.devices.values()].filter((d) => d.online).length} devices online on the network`);
    }
    this.#save();
  }

  #touch(ip, patch, neighbors) {
    const mac = neighbors.get(ip)?.mac ?? [...this.devices.values()].find((d) => d.ip === ip && d.mac)?.mac;
    const shared = mac && this.#sharedMacs.has(mac);
    const key = mac ? (shared ? `${mac}|${ip}` : mac) : `ip:${ip}`;
    let d = this.devices.get(key);
    if (mac && this.devices.has(`ip:${ip}`)) {
      // We now know the MAC for a device first seen only by IP — merge.
      d = { ...this.devices.get(`ip:${ip}`), ...d };
      this.devices.delete(`ip:${ip}`);
    }
    const now = new Date().toISOString();
    const isNew = !d;
    d ??= { key, firstSeen: now, services: [] };
    d.key = key;
    d.ip = ip;
    if (mac) d.mac = mac;
    d.viaExtender = Boolean(shared);
    d.vendor = shared ? null : (vendorFor(d.mac) ?? d.vendor ?? null);
    if (patch.services) d.services = [...new Set([...(d.services ?? []), ...patch.services])];
    if (patch.names) d.names = { ...d.names, ...patch.names };
    if (patch.ssdp) d.ssdp = { ...d.ssdp, ...patch.ssdp };
    if (patch.txt) d.txt = { ...d.txt, ...patch.txt };
    if (patch.govee) d.govee = patch.govee;
    if (patch.name) d.names = { ...d.names, _friendly: patch.name };
    d.name = pickName(d);
    Object.assign(d, classify(d));
    d.lastSeen = now;
    const wasOnline = d.online;
    d.online = true;
    this.devices.set(key, d);

    if (!this.#warm) return;
    if (isNew && this.#baseline) {
      d.isNew = true; // first appeared after Playlite already knew the network — worth a badge
      this.#emit('device.new', d);
    }
    else if (!wasOnline && !isNew) this.#emit('device.online', d);
  }

  #checkOffline() {
    const cutoff = Date.now() - this.offlineAfterMs;
    for (const d of this.devices.values()) {
      if (d.online && Date.parse(d.lastSeen) < cutoff) {
        d.online = false;
        if (this.#warm) this.#emit('device.offline', d);
      }
    }
  }

  #emit(type, d) {
    this.emit('event', {
      source: 'network',
      type,
      device: d.name ?? d.hostname ?? d.ip,
      ip: d.ip,
      mac: d.mac,
      kind: d.kind,
      label: d.label,
      at: new Date().toISOString(),
    });
  }

  // ---------- mDNS ----------
  #mdns(seen) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const types = new Set(MDNS_TYPES);
      sock.on('error', () => {});
      sock.on('message', (buf, rinfo) => {
        let pkt;
        try {
          pkt = decodePacket(buf);
        } catch {
          return;
        }
        if (!pkt.response) return;
        // A packet can describe other hosts (proxies/reflectors): use SRV→A to find the real IP.
        const hostIp = new Map(pkt.records.filter((r) => r.type === TYPE.A).map((r) => [r.name, r.data]));
        const srvIp = new Map(pkt.records.filter((r) => r.type === TYPE.SRV).map((r) => [r.name, hostIp.get(r.data.target)]));
        const ownerOf = (name) => srvIp.get(name) ?? (hostIp.size === 1 ? [...hostIp.values()][0] : null) ?? rinfo.address;
        const patchFor = (ip) => {
          const p = seen.get(ip) ?? { services: [] };
          p.services ??= [];
          seen.set(ip, p);
          return p;
        };
        for (const r of pkt.records) {
          const subject = r.type === TYPE.PTR ? r.data : r.name;
          // Sleep proxies answer for sleeping devices; some names carry the real IP, e.g. "Hue Bridge (192.168.1.161)".
          const named = /\((\d{1,3}(?:\.\d{1,3}){3})\)/.exec(subject)?.[1];
          const patch = patchFor(named ?? ownerOf(subject));
          if (r.type === TYPE.PTR && r.name === '_services._dns-sd._udp.local') {
            if (!types.has(r.data)) {
              types.add(r.data);
              sock.send(encodeQuery([r.data]), 5353, MDNS_ADDR, () => {});
            }
          } else if (r.type === TYPE.PTR) {
            const service = r.name.replace(/\.local$/, '');
            patch.services.push(service);
            const instance = r.data.slice(0, r.data.length - r.name.length - 1)
              .replace(/\\(\d{3})/g, (_, n) => String.fromCharCode(+n)).replace(/\\/g, '')
              .replace(/\s*\[[0-9a-f:]{17}\]$/i, ''); // "_workstation" names end in "[mac]"
            if (instance && !/^[0-9a-f-]{20,}$/i.test(instance) && !/^[0-9A-F]{12}@/.test(instance)) {
              patch.names = { ...patch.names, [service]: instance };
            }
          } else if (r.type === TYPE.TXT) {
            patch.txt = { ...patch.txt, ...r.data };
            const friendly = r.data.fn ?? r.data.friendly_name ?? r.data.location_name;
            if (typeof friendly === 'string' && friendly) patch.names = { ...patch.names, _friendly: friendly };
          }
        }
      });
      sock.bind(0, () => {
        try {
          sock.setMulticastInterface(primaryIp());
        } catch {
          // keep default interface
        }
        const send = () => sock.send(encodeQuery([...types]), 5353, MDNS_ADDR, () => {});
        send();
        setTimeout(send, 800);
      });
      setTimeout(() => {
        sock.close();
        resolve();
      }, 2500);
    });
  }

  // ---------- SSDP ----------
  #ssdp(seen) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const locations = new Map();
      sock.on('error', () => {});
      sock.on('message', (buf, rinfo) => {
        const headers = {};
        for (const line of buf.toString().split(/\r?\n/).slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const patch = seen.get(rinfo.address) ?? {};
        patch.ssdp = { ...patch.ssdp, server: headers.server ?? patch.ssdp?.server, st: [patch.ssdp?.st, headers.st].filter(Boolean).join(' ') };
        if (headers.location) locations.set(headers.location, rinfo.address);
        seen.set(rinfo.address, patch);
      });
      sock.bind(0, () => {
        try {
          sock.setMulticastInterface(primaryIp());
        } catch {
          // keep default interface
        }
        const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
        sock.send(msg, 1900, SSDP_ADDR, () => {});
        setTimeout(() => sock.send(msg, 1900, SSDP_ADDR, () => {}), 700);
      });
      setTimeout(async () => {
        sock.close();
        // Read device descriptions (friendly name, maker, model) — cached per URL.
        await Promise.all([...locations].map(async ([loc, ip]) => {
          if (!this.#descCache.has(loc)) {
            const xml = await fetch(loc, { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).catch(() => '');
            const tag = (t) => new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml)?.[1]?.trim();
            this.#descCache.set(loc, { friendlyName: tag('friendlyName'), manufacturer: tag('manufacturer'), model: tag('modelName') });
          }
          const desc = this.#descCache.get(loc);
          const patch = seen.get(ip);
          patch.ssdp = { ...patch.ssdp, ...Object.fromEntries(Object.entries(desc).filter(([, v]) => v)) };
          if (desc.friendlyName && !patch.name) patch.name = desc.friendlyName;
        }));
        resolve();
      }, 3000);
    });
  }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}
