// Govee LAN API driver (UDP). "LAN Control" must be enabled per device in the Govee Home app.
//   discovery: multicast 239.255.255.250:4001  -> replies to us on :4002
//   control:   unicast  <device-ip>:4003
// Govee has no native transitions, so the light controller fades in software.
import dgram from 'node:dgram';
import { clamp, hexToRgb, rgbToHex } from '../util.js';

const MULTICAST = '239.255.255.250';
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const CMD_PORT = 4003;

export class GoveeDriver {
  supportsTransition = false;
  socket = null;
  #pendingStatus = new Map(); // ip -> resolve
  #scanResults = null;

  constructor(getConfig, saveDevices, log) {
    this.getConfig = getConfig;
    this.saveDevices = saveDevices;
    this.log = log;
  }

  get devices() { return this.getConfig().govee.devices; }

  start() {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => this.#onMessage(buf, rinfo));
    sock.on('error', (err) => this.log.error(`Govee UDP socket: ${err.message}`));
    sock.bind(LISTEN_PORT, () => {
      const iface = this.getConfig().govee.multicastInterface || this.defaultInterface;
      try {
        if (iface) sock.setMulticastInterface(iface);
      } catch (err) {
        this.log.warn(`Govee: could not use interface ${iface}: ${err.message}`);
      }
    });
    this.socket = sock;
    // Refresh IPs periodically in case DHCP moved a device.
    this.rescanTimer = setInterval(() => this.scan().catch(() => {}), 5 * 60_000).unref();
    setTimeout(() => this.scan().catch(() => {}), 1000).unref();
  }

  stop() {
    clearInterval(this.rescanTimer);
    this.socket?.close();
    this.socket = null;
  }

  #onMessage(buf, rinfo) {
    let msg;
    try {
      msg = JSON.parse(buf.toString())?.msg;
    } catch {
      return;
    }
    if (msg?.cmd === 'scan' && this.#scanResults) {
      const d = msg.data;
      this.#scanResults.set(d.device, { ip: d.ip ?? rinfo.address, sku: d.sku });
    } else if (msg?.cmd === 'devStatus') {
      this.#pendingStatus.get(rinfo.address)?.(msg.data);
      this.#pendingStatus.delete(rinfo.address);
    }
  }

  #send(ip, port, msg) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Govee driver not started'));
      this.socket.send(JSON.stringify({ msg }), port, ip, (err) => (err ? reject(err) : resolve()));
    });
  }

  async scan(waitMs = 2500) {
    this.#scanResults = new Map();
    await this.#send(MULTICAST, SCAN_PORT, { cmd: 'scan', data: { account_topic: 'reserve' } });
    await new Promise((r) => setTimeout(r, waitMs));
    const found = this.#scanResults;
    this.#scanResults = null;
    let changed = false;
    for (const [id, info] of found) {
      const prev = this.devices[id];
      if (!prev || prev.ip !== info.ip) changed = true;
      this.devices[id] = { name: prev?.name ?? `${info.sku} ${id.slice(-5)}`, ...prev, ...info };
    }
    if (changed) this.saveDevices();
    return [...found.keys()];
  }

  // Manually register a device that didn't answer multicast discovery.
  async addByIp(ip) {
    ip = String(ip ?? '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Enter the light's IP address, e.g. 192.168.1.50");
    const status = await this.#status(ip);
    if (!status) throw new Error(`No reply from ${ip}. Is LAN Control enabled in the Govee app? Another program on this PC that talks to Govee lights (SignalRGB, Govee Desktop, Home Assistant) can also take the replies — close it and try again.`);
    const id = `ip-${ip}`;
    this.devices[id] = { name: `Govee ${ip}`, ...this.devices[id], ip, sku: this.devices[id]?.sku ?? 'unknown' };
    this.saveDevices();
    return id;
  }

  list() {
    return Object.entries(this.devices).map(([id, d]) => ({
      id: `govee:${id}`,
      name: d.name,
      kind: 'govee',
      ip: d.ip,
      sku: d.sku,
    }));
  }

  #ip(ref) {
    const ip = this.devices[ref]?.ip;
    if (!ip) throw new Error(`Unknown Govee device ${ref}`);
    return ip;
  }

  async apply(ref, params) {
    const ip = this.#ip(ref);
    const off = params.on === false || params.brightness === 0;
    if (off) return this.#send(ip, CMD_PORT, { cmd: 'turn', data: { value: 0 } });
    if (params.on === true || params.brightness != null) await this.#send(ip, CMD_PORT, { cmd: 'turn', data: { value: 1 } });
    if (params.kelvin) {
      await this.#send(ip, CMD_PORT, {
        cmd: 'colorwc',
        data: { color: { r: 255, g: 255, b: 255 }, colorTemInKelvin: clamp(params.kelvin, 2000, 9000) },
      });
    } else if (params.color) {
      const rgb = hexToRgb(params.color);
      if (rgb) await this.#send(ip, CMD_PORT, { cmd: 'colorwc', data: { color: rgb, colorTemInKelvin: 0 } });
    }
    if (params.brightness != null) {
      await this.#send(ip, CMD_PORT, { cmd: 'brightness', data: { value: clamp(Math.round(params.brightness), 1, 100) } });
    }
  }

  // Brightness-only update used by software fades (skips the extra "turn on" packet).
  setBrightness(ref, brightness) {
    return this.#send(this.#ip(ref), CMD_PORT, { cmd: 'brightness', data: { value: clamp(Math.round(brightness), 1, 100) } });
  }

  #status(ip, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingStatus.delete(ip);
        resolve(null);
      }, timeoutMs);
      this.#pendingStatus.set(ip, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.#send(ip, CMD_PORT, { cmd: 'devStatus', data: {} }).catch(() => resolve(null));
    });
  }

  async getState(ref) {
    const s = await this.#status(this.#ip(ref));
    if (!s) return null;
    return {
      on: s.onOff === 1,
      brightness: s.brightness,
      ...(s.colorTemInKelvin ? { kelvin: s.colorTemInKelvin } : s.color ? { color: rgbToHex(s.color) } : {}),
    };
  }
}
