// People and whether they're home. Each person can be tracked by any mix of:
//   · network devices — their phone on the Wi-Fi (from discovery)
//   · OwnTracks — the phone's GPS, over MQTT (owntracks/<user>/<device>) or HTTP (POST /presence/owntracks?key=…&person=…)
//   · Home Assistant — a person.* or device_tracker.* entity
//   · iOS Shortcuts / Tasker / anything — GET /presence/<person>/home|away?key=…
// Phones nap on Wi-Fi, so once a person has one of the other sources the network can only say "arrived" (phone joined
// the Wi-Fi), never "left" — leaving comes from the GPS / HA / Shortcut.
// -> engine events { source:'presence', type:'person.arrives'|'person.leaves', person, by }
//                  { source:'presence', type:'house.occupied'|'house.empty', person, by }   (first one home / last one out)
import { EventEmitter } from 'node:events';
import { contains } from './util.js';

const RADIUS_M = 150; // within this of the home location = home (OwnTracks without a "home" region)

export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

export class Presence extends EventEmitter {
  #where = new Map(); // person id -> { distance, acc, at }
  #timer = null;

  constructor({ getConfig, updateConfig, discovery = null, mqtt = null, ha = null, log }) {
    super();
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.discovery = discovery;
    this.log = log;
    discovery?.on('event', (e) => this.onNetwork(e));
    mqtt?.on('event', (e) => this.onMqtt(e));
    ha?.on('event', (e) => this.onHa(e));
  }

  get people() { return this.getConfig().people ?? []; }

  find(q) {
    const s = String(q ?? '').trim().toLowerCase();
    if (!s) return null;
    return this.people.find((p) => p.id === s || p.name.toLowerCase() === s) ?? this.people.find((p) => p.name.toLowerCase().includes(s)) ?? null;
  }

  // has a source that can tell "left" reliably (the network can't)
  strong(p) { return Boolean(p.owntracks || p.ha || p.shortcuts); }

  start() {
    // the network can drift while Playlite is off — re-check network-only people every minute, once discovery has warmed up
    const t = setTimeout(() => {
      this.reconcile();
      this.#timer = setInterval(() => this.reconcile(), 60_000);
      this.#timer.unref?.();
    }, 3 * 60_000);
    t.unref?.();
    this.#timer = t;
  }

  stop() {
    clearTimeout(this.#timer);
    clearInterval(this.#timer);
  }

  // Record a change and tell the engine. Returns false if nothing changed.
  set(person, state, by) {
    const p = typeof person === 'object' ? person : this.find(person);
    if (!p) throw new Error(`No person called "${person}"`);
    if (state !== 'home' && state !== 'away') throw new Error('state must be home or away');
    if (p.state === state) return false;
    const homeBefore = this.people.filter((x) => x.state === 'home').length;
    this.updateConfig((c) => {
      const x = c.people.find((y) => y.id === p.id);
      Object.assign(x, { state, since: new Date().toISOString(), by });
    });
    const homeAfter = this.people.filter((x) => x.state === 'home').length;
    const at = new Date().toISOString();
    this.emit('event', { source: 'presence', type: state === 'home' ? 'person.arrives' : 'person.leaves', person: p.name, by, home: homeAfter, at });
    if (!homeBefore && homeAfter) this.emit('event', { source: 'presence', type: 'house.occupied', person: p.name, by, home: homeAfter, at });
    if (homeBefore && !homeAfter) this.emit('event', { source: 'presence', type: 'house.empty', person: p.name, by, home: 0, at });
    return true;
  }

  // ---------- network ----------
  devicesOnline(p) {
    return (p.devices ?? []).some((spec) => this.discovery?.find(spec).some((d) => d.online));
  }

  onNetwork(e) {
    if (e.type !== 'device.online' && e.type !== 'device.offline') return;
    for (const p of this.people) {
      if (!(p.devices ?? []).some((spec) => contains([e.device, e.ip, e.mac, e.label].join(' '), spec))) continue;
      if (e.type === 'device.online') this.set(p, 'home', 'Wi-Fi');
      else if (!this.strong(p) && !this.devicesOnline(p)) this.set(p, 'away', 'Wi-Fi');
    }
  }

  reconcile() {
    for (const p of this.people) {
      if (!p.devices?.length || this.strong(p)) continue;
      const online = this.devicesOnline(p);
      if (online && p.state !== 'home') this.set(p, 'home', 'Wi-Fi');
      if (!online && p.state === 'home') this.set(p, 'away', 'Wi-Fi');
    }
  }

  // ---------- OwnTracks ----------
  onMqtt(e) {
    const m = /^owntracks\/([^/]+)\/([^/]+)$/.exec(e.topic ?? '');
    if (!m || !e.json) return;
    const id = `${m[1]}/${m[2]}`.toLowerCase();
    const p = this.people.find((x) => x.owntracks && (x.owntracks.toLowerCase() === id || x.owntracks.toLowerCase() === m[1].toLowerCase()));
    if (p) this.owntracks(p, e.json);
  }

  // One OwnTracks message (location or region transition). Home = inside the "home" region, or near the home location.
  owntracks(person, msg) {
    const p = typeof person === 'object' ? person : this.find(person);
    if (!p) throw new Error(`No person called "${person}"`);
    const region = String(p.region || 'home').toLowerCase();
    if (msg?._type === 'transition' && String(msg.desc ?? '').toLowerCase() === region) {
      this.set(p, msg.event === 'enter' ? 'home' : 'away', 'OwnTracks');
      return;
    }
    if (msg?._type !== 'location') return;
    if (Array.isArray(msg.inregions) && msg.inregions.some((r) => String(r).toLowerCase() === region)) {
      this.#where.set(p.id, { distance: 0, acc: msg.acc ?? null, at: new Date().toISOString() });
      this.set(p, 'home', 'OwnTracks');
      return;
    }
    const home = this.getConfig().location;
    if (!Number.isFinite(msg.lat) || !Number.isFinite(msg.lon) || !home?.lat) return;
    const acc = Number(msg.acc) || 0;
    if (acc > 1000) return; // too vague to tell
    const d = distanceM(home, msg);
    this.#where.set(p.id, { distance: d, acc, at: new Date().toISOString() });
    const radius = Number(p.radius) || RADIUS_M;
    if (d <= radius) this.set(p, 'home', 'OwnTracks');
    else if (d > radius + Math.max(100, acc)) this.set(p, 'away', 'OwnTracks'); // a margin so GPS jitter at the edge doesn't flap
  }

  // ---------- Home Assistant ----------
  onHa(e) {
    if (e.type !== 'state' || ['unknown', 'unavailable'].includes(e.to)) return;
    for (const p of this.people) {
      if (p.ha && String(e.entity).toLowerCase() === p.ha.toLowerCase()) this.set(p, e.to === 'home' ? 'home' : 'away', 'Home Assistant');
    }
  }

  // ---------- Shortcuts / webhooks ----------
  webhook(person, state) {
    const p = this.find(person);
    if (!p) throw new Error(`No person called "${person}"`);
    if (!p.shortcuts) this.updateConfig((c) => (c.people.find((x) => x.id === p.id).shortcuts = true)); // from now on Wi-Fi alone won't say "left"
    this.set(p, state, 'Shortcut');
    return p;
  }

  // ---------- conditions ----------
  // who: a person, "anyone" or "everyone". Returns null when the check passes, else why not; undefined if who isn't a person.
  check(who, state = 'home') {
    const q = String(who ?? '').trim().toLowerCase();
    const people = this.people;
    if (q === 'anyone' || q === 'everyone' || q === 'someone' || q === 'nobody') {
      if (!people.length) return 'no people set up';
      if (q === 'nobody') return people.some((p) => p.state === 'home') ? 'someone is home' : null;
      const ok = q === 'everyone' ? people.every((p) => p.state === state) : people.some((p) => p.state === state);
      return ok ? null : `${q === 'everyone' ? 'not everyone' : 'nobody'} is ${state}`;
    }
    const p = this.find(q);
    if (!p) return undefined;
    return (p.state ?? 'away') === state ? null : `${p.name} is ${p.state ?? 'away'}`;
  }

  summary() {
    return this.people.map((p) => ({ ...p, state: p.state ?? 'away', where: this.#where.get(p.id) ?? null, devicesOnline: this.devicesOnline(p) }));
  }
}
