// Alexa (and anything else that speaks Hue) — local emulated Philips Hue bridge.
//
// Echo devices search the LAN with SSDP; we answer as a Hue bridge and serve a tiny slice of the
// Hue v1 API. Each exposed item looks like a dimmable bulb:
//   • Playlite groups     → "Alexa, set Basement to 30%"   /  "turn off Living Room"
//   • voice-named workflows → "Alexa, turn on Movie Mode"   (runs the workflow)
// Newer Echos only talk to port 80, so that's the default (configurable).
import http from 'node:http';
import dgram from 'node:dgram';
import { primaryIp, primaryMac } from '../net.js';

const SSDP_ADDR = '239.255.255.250';

export class AlexaBridge {
  status = { http: 'off', ssdp: 'off', port: null, lastRequest: null };
  #server = null;
  #ssdp = null;
  #levels = new Map(); // item key -> { on, bri }

  constructor({ getConfig, updateConfig, engine, lights, log }) {
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.engine = engine;
    this.lights = lights;
    this.log = log;
  }

  get cfg() { return this.getConfig().alexa ?? {}; }

  // Stable numeric ids per exposed item (Alexa remembers devices by id).
  items() {
    const c = this.getConfig();
    const items = [
      ...c.groups.map((g) => ({ key: `group:${g.id}`, name: g.name, kind: 'group' })),
      ...c.routines.filter((r) => r.voiceName).map((r) => ({ key: `routine:${r.id}`, name: r.voiceName, kind: 'routine', routine: r })),
    ].filter((i) => !(this.cfg.hidden ?? []).includes(i.key));
    const ids = { ...(this.cfg.ids ?? {}) };
    let next = Math.max(0, ...Object.values(ids)) + 1;
    let changed = false;
    for (const i of items) {
      if (!ids[i.key]) {
        ids[i.key] = next++;
        changed = true;
      }
      i.id = String(ids[i.key]);
    }
    if (changed) this.updateConfig((cfg) => (cfg.alexa = { ...cfg.alexa, ids }));
    return items;
  }

  get bridgeId() {
    const mac = primaryMac().replace(/:/g, '');
    return `${mac.slice(0, 6)}fffe${mac.slice(6)}`.toUpperCase();
  }

  start() {
    if (this.cfg.enabled === false) return;
    const port = this.cfg.port ?? 80;
    this.#server = http.createServer((req, res) => this.#handle(req, res).catch((err) => {
      this.log.warn(`Alexa bridge: ${err.message}`);
      res.writeHead(500).end();
    }));
    this.#server.on('error', (err) => {
      this.status.http = `error: ${err.code === 'EACCES' || err.code === 'EADDRINUSE' ? `port ${port} is busy or needs admin rights` : err.message}`;
      this.log.warn(`Alexa bridge: could not listen on port ${port} (${err.code}). Change the port under Connections → Alexa, or free port ${port}.`);
    });
    this.#server.listen(port, '0.0.0.0', () => {
      this.status.http = 'listening';
      this.status.port = port;
      this.#startSsdp(port);
    });
  }

  stop() {
    this.#server?.close();
    this.#ssdp?.close();
    this.#server = this.#ssdp = null;
    this.status = { ...this.status, http: 'off', ssdp: 'off' };
  }

  #startSsdp(port) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      this.status.ssdp = `error: ${err.message}`;
      this.log.warn(`Alexa bridge SSDP: ${err.message}`);
    });
    sock.on('message', (buf, rinfo) => {
      const text = buf.toString();
      if (!text.startsWith('M-SEARCH')) return;
      const st = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
      if (!/ssdp:all|upnp:rootdevice|device:basic:1/i.test(st)) return;
      const ip = primaryIp();
      const uuid = `2f402f80-da50-11e1-9b23-${primaryMac().replace(/:/g, '')}`;
      for (const [stv, usn] of [
        ['upnp:rootdevice', `uuid:${uuid}::upnp:rootdevice`],
        [`uuid:${uuid}`, `uuid:${uuid}`],
        ['urn:schemas-upnp-org:device:basic:1', `uuid:${uuid}::urn:schemas-upnp-org:device:basic:1`],
      ]) {
        const reply = [
          'HTTP/1.1 200 OK',
          `HOST: ${SSDP_ADDR}:1900`,
          'EXT:',
          'CACHE-CONTROL: max-age=100',
          `LOCATION: http://${ip}:${port}/description.xml`,
          'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.26.0',
          `hue-bridgeid: ${this.bridgeId}`,
          `ST: ${stv}`,
          `USN: ${usn}`,
          '', '',
        ].join('\r\n');
        sock.send(reply, rinfo.port, rinfo.address);
      }
    });
    sock.bind(1900, () => {
      try {
        sock.addMembership(SSDP_ADDR, primaryIp());
        this.status.ssdp = 'listening';
      } catch (err) {
        this.status.ssdp = `error: ${err.message}`;
      }
    });
    this.#ssdp = sock;
  }

  #lightJson(item) {
    const lvl = this.#levels.get(item.key) ?? { on: false, bri: 254 };
    return {
      state: { on: lvl.on, bri: lvl.bri, alert: 'none', mode: 'homeautomation', reachable: true },
      type: 'Dimmable light',
      name: item.name,
      modelid: 'LWB010',
      manufacturername: 'Philips',
      productname: 'Hue white lamp',
      uniqueid: `00:17:88:01:00:${item.id.padStart(4, '0').replace(/(..)(..)/, '$1:$2')}:00-0b`,
      swversion: '1.46.13_r26312',
    };
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    this.status.lastRequest = new Date().toISOString();

    if (url.pathname === '/description.xml') {
      const ip = primaryIp();
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${ip}:${this.status.port}/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>Playlite (${ip})</friendlyName>
<manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL>
<modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2015</modelName>
<modelNumber>BSB002</modelNumber>
<modelURL>http://www.meethue.com</modelURL>
<serialNumber>${primaryMac().replace(/:/g, '')}</serialNumber>
<UDN>uuid:2f402f80-da50-11e1-9b23-${primaryMac().replace(/:/g, '')}</UDN>
<presentationURL>index.html</presentationURL>
</device>
</root>`);
      return;
    }

    const parts = url.pathname.split('/').filter(Boolean); // api, user, lights, id, state
    if (parts[0] !== 'api') return res.writeHead(404).end();

    if (req.method === 'POST' && parts.length === 1) {
      this.log.info('Alexa bridge: a device paired (discovery started)');
      return json([{ success: { username: 'playlite' } }]);
    }

    const items = this.items();
    const lightsObj = () => Object.fromEntries(items.map((i) => [i.id, this.#lightJson(i)]));

    if (parts.length === 2) {
      return json({ lights: lightsObj(), groups: {}, scenes: {}, schedules: {}, sensors: {}, rules: {}, config: this.#config() });
    }
    if (parts[2] === 'config') return json(this.#config());
    if (parts[2] === 'groups' || parts[2] === 'scenes' || parts[2] === 'sensors') return json({});
    if (parts[2] !== 'lights') return json([]);
    if (parts.length === 3) return json(lightsObj());

    const item = items.find((i) => i.id === parts[3]);
    if (!item) return json([{ error: { type: 3, address: `/lights/${parts[3]}`, description: 'resource not available' } }]);
    if (req.method === 'GET') return json(this.#lightJson(item));

    if (req.method === 'PUT' && parts[4] === 'state') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const prev = this.#levels.get(item.key) ?? { on: false, bri: 254 };
      const next = { on: body.on ?? (body.bri != null ? true : prev.on), bri: body.bri ?? prev.bri };
      this.#levels.set(item.key, next);
      this.#act(item, next, body);
      return json(Object.entries(body).map(([k, v]) => ({ success: { [`/lights/${item.id}/state/${k}`]: v } })));
    }
    json([]);
  }

  #act(item, lvl, body) {
    const said = body.on === false ? 'off' : body.bri != null ? `${Math.round(lvl.bri / 2.54)}%` : 'on';
    this.engine.handle({ source: 'voice', type: 'alexa', device: item.name, value: said, at: new Date().toISOString() });
    if (item.kind === 'routine') {
      if (lvl.on) this.engine.run(item.routine, { source: 'voice', type: 'alexa', device: item.name });
      return;
    }
    const brightness = lvl.on ? Math.max(1, Math.round(lvl.bri / 2.54)) : 0;
    this.engine.run(
      { id: `alexa-${item.key}`, name: `Alexa: ${item.name} ${said}`, targets: [item.key], steps: [{ type: 'set', brightness, transitionMs: 800 }] },
      { source: 'voice', type: 'alexa' },
    );
  }

  #config() {
    const ip = primaryIp();
    return {
      name: 'Playlite',
      bridgeid: this.bridgeId,
      mac: primaryMac(),
      ipaddress: ip,
      modelid: 'BSB002',
      swversion: '1955082050',
      apiversion: '1.46.0',
      datastoreversion: '98',
      dhcp: true,
      linkbutton: true,
      zigbeechannel: 15,
      UTC: new Date().toISOString().slice(0, 19),
      whitelist: { playlite: { name: 'Echo', 'last use date': new Date().toISOString().slice(0, 19), 'create date': '2026-01-01T00:00:00' } },
    };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}
