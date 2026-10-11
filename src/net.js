// Network helpers shared by discovery, the web server and the Alexa bridge.
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';

// Home LAN ranges first; VPN/CGNAT (100.x, e.g. Tailscale) and Hyper-V/WSL (172.x) last.
const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);

export function lanInterfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .sort((a, b) => rank(a.address) - rank(b.address));
}

export const lanAddresses = () => lanInterfaces().map((a) => a.address);
export const primaryIp = () => lanAddresses()[0] ?? '127.0.0.1';
export const primaryMac = () => (lanInterfaces()[0]?.mac ?? '02:00:00:00:00:01').toLowerCase();

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// Hosts on the primary subnet (capped at a /22 so a huge network isn't hammered).
export function subnetHosts() {
  const iface = lanInterfaces()[0];
  if (!iface) return [];
  const prefix = Math.max(22, Number(iface.cidr?.split('/')[1] ?? 24));
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const base = ipToInt(iface.address) & mask;
  const count = 2 ** (32 - prefix);
  const out = [];
  for (let i = 1; i < count - 1; i++) {
    const ip = intToIp(base + i);
    if (ip !== iface.address) out.push(ip);
  }
  return out;
}

// TCP "ping": a completed connection OR an active refusal both prove the host is up.
export function tcpAlive(ip, ports = [80, 443, 62078, 8008, 22, 554], timeoutMs = 700) {
  return new Promise((resolve) => {
    let pending = ports.length;
    let done = false;
    const finish = (alive) => {
      if (done) return;
      if (alive || --pending === 0) {
        done = true;
        resolve(alive);
      }
    };
    for (const port of ports) {
      const sock = net.connect({ host: ip, port });
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => { sock.destroy(); finish(true); });
      sock.once('timeout', () => { sock.destroy(); finish(false); });
      sock.once('error', (err) => finish(err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'));
    }
  });
}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));

// IP -> { mac, reachable } from the OS neighbor (ARP) table.
export async function neighborTable() {
  const out = new Map();
  const add = (ip, mac, reachable) => {
    mac = mac?.toLowerCase().replace(/-/g, ':');
    if (!mac || mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5e')) return;
    if (/^(224|239|255)\./.test(ip) || ip.endsWith('.255')) return;
    out.set(ip, { mac, reachable });
  };
  if (process.platform === 'win32') {
    const json = await run('powershell.exe', ['-NoProfile', '-Command',
      'Get-NetNeighbor -AddressFamily IPv4 | Select-Object IPAddress,LinkLayerAddress,@{n="State";e={"$($_.State)"}} | ConvertTo-Json -Compress']);
    try {
      const rows = [].concat(JSON.parse(json || '[]'));
      for (const r of rows) {
        if (r.State === 'Unreachable' || r.State === 'Incomplete' || r.State === 'Permanent') continue;
        add(r.IPAddress, r.LinkLayerAddress, ['Reachable', 'Delay', 'Probe'].includes(r.State));
      }
    } catch {
      for (const m of (await run('arp', ['-a'])).matchAll(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+dynamic/gi)) add(m[1], m[2], false);
    }
  } else if (process.platform === 'linux') {
    for (const line of (await run('ip', ['-4', 'neigh'])).split('\n')) {
      const m = /^(\S+) .*lladdr (\S+) (\w+)/.exec(line);
      if (m && m[3] !== 'FAILED') add(m[1], m[2], ['REACHABLE', 'DELAY', 'PROBE'].includes(m[3]));
    }
  } else {
    for (const m of (await run('arp', ['-an'])).matchAll(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/gi)) add(m[1], m[2], false);
  }
  return out;
}
