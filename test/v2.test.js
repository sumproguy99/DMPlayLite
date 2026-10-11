import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sunTimes, moonPhase, isFullMoon } from '../src/solar.js';
import { Auth } from '../src/auth.js';
import { handleMcp } from '../src/mcp.js';
import { createTools, normalizeWorkflow } from '../src/tools.js';
import { sleep } from '../src/util.js';
import { Engine, matchesTrigger, template, ntfyRequest } from '../src/engine.js';
import { nextFireToday, Scheduler } from '../src/scheduler.js';
import { classify, vendorFor, pickName } from '../src/discovery.js';
import { encodeQuery, decodePacket } from '../src/dns.js';
import { Mqtt, topicMatches, parsePackets, publishPacket, decodePublish } from '../src/integrations/mqtt.js';
import { startBroker } from './mini-broker.js';
import { WledDriver } from '../src/integrations/wled.js';
import { HueSensors } from '../src/integrations/huesensors.js';
import { PlexIntegration } from '../src/integrations/plex.js';
import { Roku } from '../src/integrations/roku.js';
import { Weather, conditionOf, conditionIs, readingMatches } from '../src/integrations/weather.js';
import { Frigate } from '../src/integrations/frigate.js';
import { EventEmitter } from 'node:events';
import http from 'node:http';

test('sunrise/sunset are plausible (Nashville, June 21)', () => {
  const { sunrise, sunset } = sunTimes(new Date('2026-06-21T12:00:00-05:00'), 36.16, -86.78);
  // Expected ≈ 10:30 UTC and ≈ 01:10 UTC next day (5:30am / 8:10pm CDT)
  const riseUtc = sunrise.getUTCHours() + sunrise.getUTCMinutes() / 60;
  const setUtc = (sunset.getUTCHours() + 24 * (sunset.getUTCDate() !== 21)) + sunset.getUTCMinutes() / 60;
  assert.ok(Math.abs(riseUtc - 10.5) < 0.25, `sunrise ${sunrise.toISOString()}`);
  assert.ok(Math.abs(setUtc - 25.15) < 0.25, `sunset ${sunset.toISOString()}`);
});

test('moon phase: known full moon is full', () => {
  // Full moon: 2026-01-03 10:03 UTC
  const p = moonPhase(new Date('2026-01-03T10:03:00Z'));
  assert.ok(Math.abs(p - 0.5) < 0.03, `phase ${p}`);
  assert.ok(isFullMoon(new Date('2026-01-03T10:03:00Z')));
  assert.ok(!isFullMoon(new Date('2026-01-10T10:03:00Z')));
});

test('accounts: create, login, wrong password, lockout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-auth-'));
  const auth = new Auth(dir);
  assert.equal(auth.hasUsers, false);
  assert.throws(() => auth.createUser('me', 'short'), /8 characters/);
  auth.createUser('dustin', 'correct horse');
  const token = auth.login('Dustin', 'correct horse', '1.1.1.1');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(auth.check({ headers: { cookie: `playlite_session=${token}` } }), 'dustin');
  // persisted across instances
  assert.equal(new Auth(dir).check({ headers: { cookie: `playlite_session=${token}` } }), 'dustin');
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('dustin', 'nope', '2.2.2.2'), /Wrong/);
  assert.throws(() => auth.login('dustin', 'correct horse', '2.2.2.2'), /Too many/);
  assert.ok(!fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes('correct horse'));
});

function fakeCtx() {
  const config = { groups: [{ id: 'den', name: 'Den', members: [] }], routines: [], location: { lat: 36.16, lon: -86.78 } };
  const log = { entries: [], info() {}, warn() {}, error() {}, event() {} };
  const lights = { list: async () => [{ id: 'hue:light:1', name: 'Lamp', kind: 'hue-light' }], resolve: (t) => t ?? [], claim: () => new Map(), release() {} };
  const discovery = { list: () => [{ name: 'DMF-iPhone', ip: '192.168.1.223', online: true, label: 'iPhone' }], find: (q) => [{ name: 'DMF-iPhone', online: q.includes('iPhone') }] };
  const engine = new Engine({ getConfig: () => config, lights, log, discovery });
  const tools = createTools({ getConfig: () => config, updateConfig: (fn) => fn(config), engine, lights, discovery, ha: null, log });
  return { config, tools, engine, discovery };
}

test('MCP: initialize, list tools, call tool, save workflow', async () => {
  const { tools, config } = fakeCtx();
  const init = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
  const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools);
  assert.ok(list.result.tools.some((t) => t.name === 'save_workflow'));
  const lights = await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_lights', arguments: {} } }, tools);
  assert.match(lights.result.content[0].text, /group:den/);
  const saved = await handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'save_workflow', arguments: { workflow: {
    name: 'Phone home', trigger: { source: 'network', event: 'device.online', device: 'iPhone' }, targets: ['group:den'], steps: [{ type: 'set', brightness: 80 }],
  } } } }, tools);
  assert.ok(!saved.result.isError, saved.result.content[0].text);
  assert.equal(config.routines.length, 1);
  const bad = await handleMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'save_workflow', arguments: { workflow: { name: 'x' } } } }, tools);
  assert.equal(bad.result.isError, true);
  const unknown = await handleMcp({ jsonrpc: '2.0', id: 6, method: 'nope' }, tools);
  assert.equal(unknown.error.code, -32601);
});

test('workflow validation', () => {
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'explode' }] }), /Unknown step/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'http', url: 'ftp://x' }] }), /http/);
  const w = normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'pulse' }] });
  assert.ok(w.id && w.steps[0].levels.length === 3);
});

test('new trigger matchers: network & Home Assistant', () => {
  assert.ok(matchesTrigger({ source: 'network', event: 'device.online', device: 'iphone' }, { source: 'network', type: 'device.online', device: 'DMF-iPhone' }));
  assert.ok(!matchesTrigger({ source: 'network', event: 'device.online', device: 'ipad' }, { source: 'network', type: 'device.online', device: 'DMF-iPhone' }));
  const door = { source: 'homeassistant', type: 'state', entity: 'binary_sensor.front_door', name: 'Front Door', from: 'off', to: 'on' };
  assert.ok(matchesTrigger({ source: 'homeassistant', event: 'state', entity: 'front door', to: 'on' }, door));
  assert.ok(!matchesTrigger({ source: 'homeassistant', event: 'state', entity: 'front door', to: 'off' }, door));
});

test('conditions: presence, dark, full moon', () => {
  const { engine } = fakeCtx();
  const noon = new Date('2026-06-21T12:00:00-05:00');
  const night = new Date('2026-06-21T23:30:00-05:00');
  assert.match(engine.blockedBy({ conditions: { dark: true } }, noon), /daytime/);
  assert.equal(engine.blockedBy({ conditions: { dark: true } }, night), null);
  assert.equal(engine.blockedBy({ conditions: { presence: { device: 'iPhone', state: 'home' } } }), null);
  assert.match(engine.blockedBy({ conditions: { presence: { device: 'iPad', state: 'home' } } }), /away/);
  assert.match(engine.blockedBy({ conditions: { fullMoon: true } }, new Date('2026-01-10T12:00:00Z')), /full moon/);
});

test('templates fill in event details', () => {
  assert.equal(template('{{player}} started {{title}}', { player: 'TV', title: 'Dune' }), 'TV started Dune');
  assert.deepEqual(template({ msg: '{{to}}', n: 3 }, { to: 'open' }), { msg: 'open', n: 3 });
});

test('scheduler: clock time, weekdays, sunset offset', () => {
  const now = new Date('2026-06-22T18:00:00'); // Monday
  assert.equal(nextFireToday({ event: 'time.at', at: '07:30' }, now).getHours(), 7);
  assert.equal(nextFireToday({ event: 'time.at', at: '07:30', days: [0, 6] }, now), null);
  const loc = { lat: 36.16, lon: -86.78 };
  const sunset = nextFireToday({ event: 'sun.sunset' }, now, loc);
  const before = nextFireToday({ event: 'sun.sunset', offsetMin: -30 }, now, loc);
  assert.equal(sunset - before, 30 * 60_000);
  assert.equal(nextFireToday({ event: 'sun.sunset' }, now, {}), null);
});

test('discovery: classification, vendor, naming', () => {
  assert.equal(classify({ services: ['_googlecast._tcp'] }).kind, 'chromecast');
  assert.equal(classify({ hostname: 'Wyze_Duo_Cam_Pan' }).kind, 'camera');
  assert.equal(classify({ hostname: 'Tstat-06D42D' }).kind, 'thermostat');
  assert.equal(classify({ name: 'DMF-iPhone' }).kind, 'phone');
  assert.match(vendorFor('da:11:22:33:44:55'), /Private/);
  assert.equal(vendorFor('00:17:88:aa:bb:cc'), 'Philips Hue');
  assert.equal(pickName({ names: { '_spotify-connect._tcp': 'SpotifyConnect', '_hue._tcp': 'Hue Bridge' } }), 'Hue Bridge');
});

test('dns codec round-trips a query', () => {
  const q = encodeQuery(['_hue._tcp.local']);
  // Turn the query into a fake response with one PTR answer pointing back at the question name.
  const header = Buffer.from(q.subarray(0, 12));
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const question = q.subarray(12);
  const answer = Buffer.concat([Buffer.from([0xc0, 12]), Buffer.from([0, 12, 0, 1, 0, 0, 0, 120, 0, 8]), Buffer.from([5, 0x42, 0x72, 0x69, 0x64, 0x67]), Buffer.from([0xc0, 12])]);
  const pkt = decodePacket(Buffer.concat([header, question, answer]));
  assert.ok(pkt.response);
  assert.equal(pkt.records[0].data, 'Bridg._hue._tcp.local');
});

test('notify: ntfy request, validation, and a routine sends it', async () => {
  const event = { player: 'Living Room', title: 'Dune' };
  const { url, init } = ntfyRequest(
    { message: '{{player}} started {{title}}', title: 'Movie', priority: 4, tags: 'movie_camera, popcorn', click: 'https://x.test/{{title}}' },
    { server: 'https://ntfy.example.com/', topic: 'den-abc', token: 'tk_secret' },
    event,
  );
  assert.equal(url, 'https://ntfy.example.com');
  assert.equal(init.headers.Authorization, 'Bearer tk_secret');
  assert.deepEqual(JSON.parse(init.body), { topic: 'den-abc', message: 'Living Room started Dune', title: 'Movie', priority: 4, tags: ['movie_camera', 'popcorn'], click: 'https://x.test/Dune' });
  // step topic overrides the default; no token → no auth header; defaults to ntfy.sh
  const plain = ntfyRequest({ message: 'hi', topic: 'other' }, { topic: 'den-abc' });
  assert.equal(plain.url, 'https://ntfy.sh');
  assert.equal(JSON.parse(plain.init.body).topic, 'other');
  assert.equal(plain.init.headers.Authorization, undefined);
  assert.throws(() => ntfyRequest({ message: 'hi' }, {}), /topic/);

  const wf = (step) => ({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'notify', ...step }] });
  assert.throws(() => normalizeWorkflow(wf({ message: ' ' })), /message/);
  assert.throws(() => normalizeWorkflow(wf({ message: 'hi', priority: 9 })), /priority/);
  assert.throws(() => normalizeWorkflow(wf({ message: 'hi', click: 'javascript:alert(1)' })), /click/);
  assert.ok(normalizeWorkflow(wf({ message: 'hi', priority: 5 })));

  const { engine, config } = fakeCtx();
  config.ntfy = { server: 'https://ntfy.sh', topic: 'den-abc', token: '' };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opts) => (sent.push({ u, body: JSON.parse(opts.body) }), { ok: true, status: 200 });
  try {
    await engine.run({ id: 'r1', name: 'alert', steps: [{ type: 'notify', message: '{{title}} is on' }] }, { source: 'plex', type: 'media.play', title: 'Dune' });
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(engine.sendNtfy({ message: 'x' }), /403.*token/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [{ u: 'https://ntfy.sh', body: { topic: 'den-abc', message: 'Dune is on' } }]);
});

test('or-triggers: any trigger starts the workflow, incl. scheduled ones', () => {
  const { engine, config } = fakeCtx();
  const fired = [];
  engine.fire = (r, e) => fired.push(`${r.id}:${e.source}:${e.type}`);
  config.routines = [{
    id: 'w', name: 'Welcome', enabled: true, steps: [{ type: 'wait', ms: 0 }],
    trigger: { source: 'network', event: 'device.online', device: 'iPhone' },
    orTriggers: [{ source: 'webhook', event: 'home' }, { source: 'time', event: 'time.at', at: '18:00' }, { source: 'time', event: 'time.at', at: '19:00' }],
  }];
  engine.handle({ source: 'network', type: 'device.online', device: 'DMF-iPhone', quiet: true });
  engine.handle({ source: 'webhook', type: 'home', quiet: true });
  engine.handle({ source: 'webhook', type: 'away', quiet: true });
  assert.deepEqual(fired, ['w:network:device.online', 'w:webhook:home']);

  // The scheduler skips times before it was created, so use tomorrow's date.
  const day = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA');
  const at = (hhmm) => new Date(`${day}T${hhmm}:30`);
  const s = new Scheduler({ getConfig: () => config, engine, log: { event() {} } });
  fired.length = 0;
  s.tick(at('18:00'));
  s.tick(at('18:01')); // same trigger, same day → only once
  s.tick(at('19:00'));
  assert.deepEqual(fired, ['w:time:time.at', 'w:time:time.at']);

  const wf = (extra) => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'wait' }], ...extra });
  assert.throws(() => wf({ orTriggers: [{ source: 'plex' }] }), /extra trigger/);
  assert.throws(() => wf({ orTriggers: 'nope' }), /list/);
  assert.equal(wf({ orTriggers: [] }).orTriggers, undefined);
});

test('house modes: set, trigger on change, condition, step, loop guard', async () => {
  const { engine, config, tools } = fakeCtx();
  Object.assign(config, { mode: 'home', modes: ['home', 'away', 'movie', 'sleep'] });
  const fired = [];
  const realFire = engine.fire.bind(engine);
  engine.fire = (r, e) => (fired.push(`${r.id}:${e.from}->${e.to}`), realFire(r, e));
  config.routines = [
    { id: 'dim', enabled: true, name: 'Movie dims', trigger: { source: 'mode', event: 'mode.changed', to: 'movie' }, steps: [{ type: 'wait', ms: 0 }] },
    { id: 'any', enabled: true, name: 'Any change', trigger: { source: 'mode', event: 'mode.changed' }, steps: [{ type: 'wait', ms: 0 }] },
  ];
  assert.equal(engine.setMode('Movie', 'test'), true);
  assert.equal(config.mode, 'movie');
  assert.equal(engine.setMode('movie'), false); // no change → no event
  assert.throws(() => engine.setMode('disco'), /Unknown mode.*home, away/);
  assert.deepEqual(fired, ['dim:home->movie', 'any:home->movie']);

  assert.equal(engine.blockedBy({ conditions: { mode: 'movie' } }), null);
  assert.match(engine.blockedBy({ conditions: { mode: ['sleep', 'away'] } }), /mode is movie/);

  await engine.run({ id: 's', name: 'Bedtime', steps: [{ type: 'mode', mode: 'sleep' }] });
  assert.equal(config.mode, 'sleep');

  // two workflows that flip the mode back and forth get stopped
  config.routines = [
    { id: 'a', enabled: true, name: 'A', trigger: { source: 'mode', event: 'mode.changed', to: 'home' }, steps: [{ type: 'mode', mode: 'away' }] },
    { id: 'b', enabled: true, name: 'B', trigger: { source: 'mode', event: 'mode.changed', to: 'away' }, steps: [{ type: 'mode', mode: 'home' }] },
  ];
  const errors = [];
  engine.log.error = (m) => errors.push(m);
  engine.setMode('home');
  await sleep(50);
  assert.ok(errors.some((m) => /back and forth/.test(m)), errors.join('\n'));

  const set = tools.find((t) => t.name === 'set_mode');
  config.mode = 'home';
  assert.deepEqual(await tools.find((t) => t.name === 'get_mode').run({}), { mode: 'home', modes: config.modes });
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'mode' }] }), /mode step/);
  config.routines = [];
  assert.deepEqual(await set.run({ mode: 'away' }), { ok: true, changed: true, mode: 'away' });
});

test('condition groups: conditions OR any orConditions group', () => {
  const { engine, config } = fakeCtx();
  Object.assign(config, { mode: 'home', modes: ['home', 'movie', 'sleep'], location: { lat: null, lon: null } });
  const noon = new Date(2024, 5, 21, 12, 0);
  const late = new Date(2024, 5, 21, 23, 0);
  const r = {
    conditions: { timeWindow: { from: '22:00', to: '06:00' } },
    orConditions: [{ mode: 'movie' }, {}],
  };
  assert.match(engine.blockedBy(r, noon), /outside 22:00–06:00 \/ mode is home/);
  assert.equal(engine.blockedBy(r, late), null); // first group passes
  config.mode = 'movie';
  assert.equal(engine.blockedBy(r, noon), null); // second group passes
  // an empty main group doesn't make everything pass
  config.mode = 'home';
  assert.match(engine.blockedBy({ conditions: {}, orConditions: [{ mode: 'sleep' }] }, noon), /mode is home/);
  assert.equal(engine.blockedBy({ conditions: {}, orConditions: [{}] }, noon), null);

  const w = normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, orConditions: [{}, { mode: [] }, { dark: true }], steps: [{ type: 'wait', ms: 0 }] });
  assert.deepEqual(w.orConditions, [{ dark: true }]);
  const w2 = normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, orConditions: [{}], steps: [{ type: 'wait', ms: 0 }] });
  assert.equal('orConditions' in w2, false);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, orConditions: { dark: true }, steps: [{ type: 'wait' }] }), /orConditions must be a list/);
});

test('for N minutes: fires only if the state holds, per device, cancels on change', async () => {
  const { engine, config } = fakeCtx();
  const fired = [];
  engine.fire = (r, e) => fired.push(`${r.id}:${e.entity ?? e.device}:${e.heldMin ?? 0}`);
  const ms = 60; // forMin is minutes
  config.routines = [
    { id: 'door', enabled: true, name: 'Door left open', trigger: { source: 'homeassistant', event: 'state', entity: 'door', to: 'on', forMin: ms / 60000 }, steps: [] },
    { id: 'now', enabled: true, name: 'Door opens', trigger: { source: 'homeassistant', event: 'state', entity: 'door', to: 'on' }, steps: [] },
  ];
  const door = (entity, to) => engine.handle({ source: 'homeassistant', type: 'state', entity, to, quiet: true });
  door('binary_sensor.front_door', 'on');
  door('binary_sensor.back_door', 'on');
  assert.deepEqual(fired, ['now:binary_sensor.front_door:0', 'now:binary_sensor.back_door:0']);
  assert.equal(engine.waiting.length, 2);
  door('binary_sensor.front_door', 'on'); // repeat doesn't restart the wait
  await sleep(ms / 2);
  door('binary_sensor.back_door', 'off'); // closed in time → cancelled
  await sleep(ms);
  assert.deepEqual(fired.filter((f) => f.startsWith('door')), [`door:binary_sensor.front_door:${ms / 60000}`]);
  assert.equal(engine.waiting.length, 0);

  // a disabled workflow doesn't fire when its wait ends
  door('binary_sensor.front_door', 'off');
  door('binary_sensor.front_door', 'on');
  config.routines[0] = { ...config.routines[0], enabled: false };
  await sleep(ms * 1.5);
  assert.equal(fired.filter((f) => f.startsWith('door')).length, 1);

  // validation
  const base = { name: 'a', steps: [{ type: 'wait', ms: 0 }] };
  assert.equal(normalizeWorkflow({ ...base, trigger: { source: 'network', event: 'device.offline', forMin: '30' } }).trigger.forMin, 30);
  assert.equal('forMin' in normalizeWorkflow({ ...base, trigger: { source: 'network', event: 'device.offline', forMin: '' } }).trigger, false);
  assert.throws(() => normalizeWorkflow({ ...base, trigger: { source: 'time', event: 'time.at', at: '10:00', forMin: 5 } }), /only works with/);
  assert.throws(() => normalizeWorkflow({ ...base, trigger: { source: 'mode', event: 'mode.changed', forMin: -1 } }), /positive/);
});

test('scenes: save, restore in a workflow, capture step, colors, MCP', async () => {
  const { LightController } = await import('../src/lights.js');
  const { xyToHex, rgbToXy, hexToRgb } = await import('../src/util.js');
  assert.equal(xyToHex(rgbToXy(hexToRgb('#ff8a3d'))), '#ff8a3d');

  const bulbs = { 1: { on: true, brightness: 80, kelvin: 2700 }, 2: { on: false, brightness: 50 }, 3: { on: true, brightness: 40, color: '#ff0000' } };
  const fake = {
    supportsTransition: true,
    list: async () => [],
    getState: async (ref) => (bulbs[ref] ? { ...bulbs[ref] } : null),
    apply: async (ref, p) => {
      const b = (bulbs[ref] ??= {});
      if (p.on === false || p.brightness === 0) b.on = false;
      else if (p.on || p.brightness != null) b.on = true;
      if (p.brightness) b.brightness = p.brightness;
      if (p.kelvin) (b.kelvin = p.kelvin), delete b.color;
      if (p.color) (b.color = p.color), delete b.kelvin;
    },
  };
  const config = { groups: [{ id: 'den', name: 'Den', members: ['fake:1', 'fake:2', 'fake:3'] }], routines: [], scenes: [] };
  const log = { entries: [], info() {}, warn() {}, error() {}, event() {} };
  const lights = new LightController({ drivers: { fake }, getConfig: () => config, log });
  const engine = new Engine({ getConfig: () => config, updateConfig: (fn) => fn(config), lights, log });

  const { scene, skipped } = await engine.saveScene('Evening', ['group:den', 'fake:9']);
  assert.deepEqual(skipped, ['fake:9']);
  assert.deepEqual(scene.lights, {
    'fake:1': { on: true, brightness: 80, kelvin: 2700 },
    'fake:2': { on: false },
    'fake:3': { on: true, brightness: 40, color: '#ff0000' },
  });
  // same name (any case) replaces, keeps the id
  bulbs[1].brightness = 81;
  assert.equal((await engine.saveScene('evening', ['fake:1'])).scene.id, scene.id);
  assert.equal(config.scenes.length, 1);
  await engine.saveScene('Evening', ['group:den']);

  // movie: capture first, then change lights; stop: restore
  await engine.run({ id: 'm', name: 'Movie', targets: ['group:den'], steps: [{ type: 'capture', scene: 'Before movie' }, { type: 'set', brightness: 10, kelvin: 2200 }] });
  assert.deepEqual([bulbs[1].brightness, bulbs[2].on, bulbs[3].kelvin], [10, true, 2200]);
  await engine.run({ id: 's', name: 'Stop', steps: [{ type: 'scene', scene: 'before MOVIE' }] });
  assert.deepEqual(bulbs[1], { on: true, brightness: 81, kelvin: 2700 });
  assert.equal(bulbs[2].on, false);
  assert.deepEqual(bulbs[3], { on: true, brightness: 40, color: '#ff0000' });

  await assert.rejects(engine.saveScene('', ['fake:1']), /needs a name/);
  await assert.rejects(engine.saveScene('X', ['fake:9']), /Couldn't read/);
  await assert.rejects(engine.applyScene('nope'), /No scene/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'x', event: 'y' }, steps: [{ type: 'scene' }] }), /scene step needs a scene name/);

  const tools = createTools({ getConfig: () => config, updateConfig: (fn) => fn(config), engine, lights, discovery: null, ha: null, log });
  const call = (name, a) => tools.find((t) => t.name === name).run(a);
  assert.deepEqual((await call('list_scenes', {})).map((x) => [x.name, x.lights]), [['Evening', 3], ['Before movie', 3]]);
  bulbs[1].brightness = 5;
  assert.deepEqual(await call('apply_scene', { scene: 'Evening' }), { ok: true, scene: 'Evening' });
  assert.equal(bulbs[1].brightness, 81);
});

test('mqtt: codec and topic wildcards', () => {
  assert.ok(topicMatches('zigbee2mqtt/+', 'zigbee2mqtt/Hall'));
  assert.ok(!topicMatches('zigbee2mqtt/+', 'zigbee2mqtt/Hall/set'));
  assert.ok(topicMatches('zigbee2mqtt/#', 'zigbee2mqtt/Hall/set'));
  assert.ok(topicMatches('a/b', 'a/b') && !topicMatches('a/b', 'a/c') && !topicMatches('a/b/c', 'a/b'));
  // a 300-byte payload needs a 2-byte length; split across chunks
  const big = publishPacket('t/x', 'y'.repeat(300), { retain: true });
  let r = parsePackets(big.subarray(0, 5));
  assert.equal(r.packets.length, 0);
  r = parsePackets(Buffer.concat([r.rest, big.subarray(5), publishPacket('t/y', 'hi')]));
  assert.equal(r.packets.length, 2);
  assert.deepEqual(decodePublish(r.packets[0]), { topic: 't/x', qos: 0, id: null, retain: true, payload: 'y'.repeat(300) });
  assert.equal(decodePublish(r.packets[1]).payload, 'hi');
});

test('mqtt: client auth, events, retained skipped, QoS1 ack, publish, triggers', async (t) => {
  const broker = await startBroker({ username: 'u', password: 'p', qos: 1 });
  t.after(() => broker.close());
  const url = `mqtt://127.0.0.1:${broker.port}`;
  await assert.rejects(Mqtt.test({ url, username: 'u', password: 'wrong' }), /wrong username or password/);
  await assert.rejects(Mqtt.test({ url: 'http://x' }), /should look like mqtt/);
  await Mqtt.test({ url, username: 'u', password: 'p' });

  broker.send('zigbee2mqtt/Hall', { occupancy: false, battery: 90 }, { retain: true });
  const config = { mqtt: { url, username: 'u', password: 'p' }, routines: [], groups: [] };
  const log = { entries: [], info() {}, warn() {}, error() {}, event() {} };
  const mqtt = new Mqtt(() => config, log);
  const events = [];
  mqtt.on('event', (e) => events.push(e));
  t.after(() => mqtt.stop());
  mqtt.restart();
  for (let i = 0; i < 50 && !mqtt.topics.size; i++) await sleep(20);
  assert.equal(mqtt.status.connected, true);
  assert.equal(events.length, 0, 'retained message must not fire workflows');
  assert.equal(mqtt.topics.get('zigbee2mqtt/Hall').json.battery, 90);

  const engine = new Engine({ getConfig: () => config, lights: { resolve: () => [], claim: () => new Map(), release() {} }, log, mqtt });
  mqtt.on('event', (e) => engine.handle(e));
  const fired = [];
  const realRun = engine.run.bind(engine);
  engine.run = (r, e) => (fired.push(`${r.id}:${e.json?.occupancy ?? e.payload}`), realRun(r, e));
  config.routines = [
    { id: 'motion', enabled: true, name: 'Motion', trigger: { source: 'mqtt', event: 'message', topic: 'zigbee2mqtt/+', field: 'occupancy', value: 'true' }, steps: [{ type: 'mqtt', topic: 'zigbee2mqtt/Lamp/set', payload: { state: 'ON', by: '{{topic}}' } }] },
    { id: 'plug', enabled: true, name: 'Plug', trigger: { source: 'mqtt', event: 'message', topic: 'stat/plug/POWER', payload: 'on' }, steps: [{ type: 'wait', ms: 0 }] },
  ];
  broker.send('zigbee2mqtt/Hall', { occupancy: true, battery: 90 });
  broker.send('zigbee2mqtt/Hall', { occupancy: true, battery: 89 }); // same occupancy → no new run
  broker.send('stat/plug/POWER', 'ON');
  broker.send('stat/plug/POWER', 'OFF');
  for (let i = 0; i < 50 && broker.received.length < 1; i++) await sleep(20);
  assert.deepEqual(fired, ['motion:true', 'plug:ON']);
  assert.deepEqual(broker.received.map((m) => [m.topic, JSON.parse(m.payload)]), [['zigbee2mqtt/Lamp/set', { state: 'ON', by: 'zigbee2mqtt/Hall' }]]);
  assert.ok(broker.acks.length >= 4, 'QoS 1 messages are acknowledged');

  // "no motion for N minutes": battery-only updates keep the wait, motion cancels it
  config.routines = [{ id: 'still', enabled: true, name: 'Still', trigger: { source: 'mqtt', event: 'message', topic: 'zigbee2mqtt/Hall', field: 'occupancy', value: 'false', forMin: 0.002 }, steps: [] }];
  broker.send('zigbee2mqtt/Hall', { occupancy: false, battery: 89 });
  await sleep(40);
  broker.send('zigbee2mqtt/Hall', { occupancy: false, battery: 88 });
  await sleep(40);
  assert.equal(engine.waiting.length, 1);
  await sleep(120);
  assert.deepEqual(fired.slice(2), ['still:false']);
  broker.send('zigbee2mqtt/Hall', { occupancy: true });
  broker.send('zigbee2mqtt/Hall', { occupancy: false });
  await sleep(40);
  broker.send('zigbee2mqtt/Hall', { occupancy: true }); // motion again → cancelled
  await sleep(150);
  assert.equal(fired.length, 3);

  assert.throws(() => mqtt.publish('a/#', 'x'), /wildcards/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'mqtt', event: 'message' }, steps: [{ type: 'wait' }] }), /needs a topic/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'webhook', event: 'x' }, steps: [{ type: 'mqtt', topic: 'a/+' }] }), /plain topic/);
  const tools = createTools({ getConfig: () => config, updateConfig: (fn) => fn(config), engine, lights: null, discovery: null, ha: null, mqtt, log });
  assert.ok((await tools.find((t) => t.name === 'mqtt_topics').run({ query: 'plug' })).some((t) => t.topic === 'stat/plug/POWER'));
});

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const readBody = (req) => new Promise((r) => {
  let b = '';
  req.on('data', (c) => (b += c)).on('end', () => r(b ? JSON.parse(b) : null));
});

test('wled: add by IP, state read-back, apply brightness / white / color / off', async (t) => {
  const state = { on: true, bri: 128, seg: [{ col: [[255, 0, 0], [0, 0, 0]] }] };
  const posts = [];
  const server = await listen(async (req, res) => {
    if (req.url === '/json/info') return res.end(JSON.stringify({ ver: '0.15.0', name: 'Shelf', mac: 'aa:bb:cc:dd:ee:ff', leds: { count: 60 } }));
    if (req.url === '/json/state' && req.method === 'POST') {
      posts.push(await readBody(req));
      return res.end('{"success":true}');
    }
    if (req.url === '/json/state') return res.end(JSON.stringify(state));
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const ip = `127.0.0.1:${server.address().port}`;
  const config = { wled: { devices: {} } };
  const wled = new WledDriver(() => config, (fn) => fn(config), { info() {} });
  assert.equal(await wled.add(ip), 'aabbccddeeff');
  assert.deepEqual(await wled.list(), [{ id: 'wled:aabbccddeeff', name: 'Shelf', kind: 'wled', ip }]);
  assert.deepEqual(await wled.getState('aabbccddeeff'), { on: true, brightness: 50, color: '#ff0000' });
  await wled.apply('aabbccddeeff', { brightness: 40 }, 2500);
  await wled.apply('aabbccddeeff', { brightness: 100, kelvin: 2700 });
  await wled.apply('aabbccddeeff', { color: '#00ff80' });
  await wled.apply('aabbccddeeff', { on: false }, 1000);
  assert.deepEqual(posts, [
    { transition: 25, on: true, bri: 102 },
    { transition: 0, on: true, bri: 255, seg: { col: [[255, 167, 87]], fx: 0, cct: 2700 } },
    { transition: 0, seg: { col: [[0, 255, 128]], fx: 0 } },
    { transition: 10, on: false },
  ]);
  await assert.rejects(wled.add('127.0.0.1:1'), /No WLED device answered/);
  await assert.rejects(wled.add('http://x/y'), /IP address/);
});

test('hue sensors: v2 event stream → motion / button / contact events', async (t) => {
  let stream;
  const server = await listen((req, res) => {
    if (req.headers['hue-application-key'] !== 'user1') return res.writeHead(403).end();
    if (req.url === '/clip/v2/resource/device') return res.end(JSON.stringify({ data: [
      { metadata: { name: 'Hall sensor' }, services: [{ rid: 'm1', rtype: 'motion' }, { rid: 'x', rtype: 'temperature' }] },
      { metadata: { name: 'Bedroom dimmer' }, services: [{ rid: 'b1', rtype: 'button' }, { rid: 'b4', rtype: 'button' }] },
      { metadata: { name: 'Front door' }, services: [{ rid: 'c1', rtype: 'contact' }] },
    ] }));
    if (req.url === '/clip/v2/resource/button') return res.end(JSON.stringify({ data: [{ id: 'b1', metadata: { control_id: 1 } }, { id: 'b4', metadata: { control_id: 4 } }] }));
    if (req.url === '/eventstream/clip/v2') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': hi\n\n');
      stream = res;
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const config = { hue: { bridgeIp: 'x', username: 'user1' }, routines: [], groups: [] };
  const log = { entries: [], info() {}, warn() {}, error() {}, event() {} };
  const sensors = new HueSensors(() => config, log);
  sensors.baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => sensors.stop());
  const events = [];
  sensors.on('event', (e) => events.push(e));
  sensors.restart();
  for (let i = 0; i < 50 && !stream; i++) await sleep(20);
  assert.equal(sensors.status.connected, true);
  assert.deepEqual(sensors.sensors(), [{ name: 'Hall sensor', kinds: ['motion'] }, { name: 'Bedroom dimmer', kinds: ['button'] }, { name: 'Front door', kinds: ['contact'] }]);

  const send = (data) => stream.write(`id: 1\ndata: ${JSON.stringify([{ type: 'update', data }])}\n\n`);
  send([{ id: 'm1', type: 'motion', motion: { motion: true, motion_report: { motion: true } } }, { id: 'zz', type: 'light', on: { on: true } }]);
  send([{ id: 'b4', type: 'button', button: { button_report: { event: 'long_press' } } }]);
  // an event split across two chunks
  const whole = `data: ${JSON.stringify([{ type: 'update', data: [{ id: 'c1', type: 'contact', contact_report: { state: 'no_contact' } }] }])}\n\n`;
  stream.write(whole.slice(0, 30));
  await sleep(20);
  stream.write(whole.slice(30));
  send([{ id: 'm1', type: 'motion', motion: { motion_report: { motion: false } } }]);
  for (let i = 0; i < 50 && events.length < 4; i++) await sleep(20);
  assert.deepEqual(events.map(({ type, device, to, button, press }) => ({ type, device, to, button, press })), [
    { type: 'motion', device: 'Hall sensor', to: 'detected', button: undefined, press: undefined },
    { type: 'button', device: 'Bedroom dimmer', to: undefined, button: 4, press: 'long_press' },
    { type: 'contact', device: 'Front door', to: 'open', button: undefined, press: undefined },
    { type: 'motion', device: 'Hall sensor', to: 'clear', button: undefined, press: undefined },
  ]);

  // triggers
  const btn = { source: 'hue', event: 'button', device: 'dimmer', button: 4, press: 'long_press' };
  assert.ok(matchesTrigger(btn, events[1]));
  assert.ok(!matchesTrigger({ ...btn, button: 1 }, events[1]));
  assert.ok(!matchesTrigger({ ...btn, press: 'short_release' }, events[1]));
  assert.ok(matchesTrigger({ source: 'hue', event: 'motion', device: 'hall', to: 'clear' }, events[3]));
  assert.equal(normalizeWorkflow({ name: 'a', trigger: { source: 'hue', event: 'button' }, steps: [{ type: 'wait' }] }).trigger.press, 'short_release');
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'hue', event: 'button', forMin: 2 }, steps: [{ type: 'wait' }] }), /only works with/);
  assert.equal(normalizeWorkflow({ name: 'a', trigger: { source: 'hue', event: 'motion', to: 'clear', forMin: 10 }, steps: [{ type: 'wait' }] }).trigger.forMin, 10);

  // wrong key → clear error, no crash
  config.hue.username = 'nope';
  sensors.restart();
  for (let i = 0; i < 50 && !sensors.status.lastError; i++) await sleep(20);
  assert.match(sensors.status.lastError, /pair it again/);
});

test('plex control: picks the player, relays via the server, falls back to the player, Roku keys', async (t) => {
  const sent = [];
  let sessions = [{ sessionKey: '1', type: 'movie', title: 'Alien', Player: { title: 'Living Room TV', machineIdentifier: 'lr', state: 'playing' } }];
  let relayWorks = true;
  const direct = await listen((req, res) => {
    sent.push(`direct ${req.url.split('?')[0]}`);
    res.end('{}');
  });
  t.after(() => direct.close());
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.headers['x-plex-token'] !== 'tok') return res.writeHead(401).end();
    if (url.pathname === '/status/sessions') return res.end(JSON.stringify({ MediaContainer: { Metadata: sessions } }));
    if (url.pathname === '/clients') return res.end(JSON.stringify({ MediaContainer: { Server: [
      { name: 'Living Room TV', machineIdentifier: 'lr', address: '127.0.0.1', port: direct.address().port },
      { name: 'Bedroom Shield', machineIdentifier: 'bd' },
    ] } }));
    if (url.pathname.startsWith('/player/playback/')) {
      sent.push(`relay ${url.pathname} ${req.headers['x-plex-target-client-identifier']} ${url.searchParams.get('type')}`);
      return relayWorks ? res.end('{}') : res.writeHead(404).end('no');
    }
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const config = { plex: { url: `http://127.0.0.1:${server.address().port}`, token: 'tok', clientId: 'c1' } };
  const plex = new PlexIntegration(() => config, { info() {}, warn() {}, error() {} });

  assert.deepEqual(await plex.control('pause'), { player: 'Living Room TV', command: 'pause' }); // the one that's playing
  assert.deepEqual(await plex.control('toggle', { player: 'living' }), { player: 'Living Room TV', command: 'pause' }); // playing → pause
  sessions[0].Player.state = 'paused';
  assert.equal((await plex.control('toggle')).command, 'play');
  await plex.control('forward', { player: 'Bedroom' }); // online but idle player, by name
  await plex.control('next', { playerId: 'lr' }); // from a Plex trigger
  relayWorks = false;
  await plex.control('stop'); // relay refuses → sent straight to the player
  assert.deepEqual(sent, [
    'relay /player/playback/pause lr video',
    'relay /player/playback/pause lr video',
    'relay /player/playback/play lr video',
    'relay /player/playback/stepForward bd video',
    'relay /player/playback/skipNext lr video',
    'relay /player/playback/stop lr video',
    'direct /player/playback/stop',
  ]);
  await assert.rejects(plex.control('pause', { player: 'Bedroom' }), /didn't accept/); // relay down, no direct address
  await assert.rejects(plex.control('pause', { player: 'Garage' }), /No Plex player called "Garage"/);
  await assert.rejects(plex.control('dance'), /Unknown Plex action/);
  sessions = [];
  await assert.rejects(plex.control('pause'), /Nothing is playing/);
  sessions = [
    { sessionKey: '1', type: 'movie', Player: { title: 'A', machineIdentifier: 'a', state: 'playing' } },
    { sessionKey: '2', type: 'track', Player: { title: 'B', machineIdentifier: 'b', state: 'playing' } },
  ];
  await assert.rejects(plex.control('pause'), /2 players are active \(A, B\)/);

  // Roku ECP
  const keys = [];
  let refuse = false;
  const rokuSrv = await listen((req, res) => {
    keys.push(`${req.method} ${req.url}`);
    res.writeHead(refuse ? 403 : 200).end();
  });
  t.after(() => rokuSrv.close());
  const port = rokuSrv.address().port;
  const roku = new Roku({ discovery: { list: () => [{ kind: 'roku', name: 'Living Room Roku', ip: '127.0.0.1', online: true }, { kind: 'tv', name: 'TV', ip: '1.2.3.4' }] }, log: {}, port });
  await roku.keypress('living', 'Play');
  await roku.keypress('', 'Home'); // only one Roku → no name needed
  await roku.launch(`127.0.0.1:${port}`, 'Plex');
  assert.deepEqual(keys, ['POST /keypress/Play', 'POST /keypress/Home', 'POST /launch/13535']);
  refuse = true;
  await assert.rejects(roku.keypress('living', 'Play'), /Control by mobile apps/);
  await assert.rejects(roku.keypress('living', 'Dance'), /Unknown Roku button/);
  await assert.rejects(roku.launch('living', 'myspace'), /Unknown Roku app/);
  await assert.rejects(roku.keypress('kitchen', 'Play'), /No Roku called "kitchen"/);

  // workflow steps: blank player = the Plex player from the trigger
  const log = { entries: [], info() {}, warn() {}, error: (m) => errors.push(m), event() {} };
  const errors = [];
  sent.length = 0;
  relayWorks = true;
  const engine = new Engine({ getConfig: () => ({ routines: [], groups: [] }), lights: { resolve: () => [], claim: () => new Map(), release() {} }, log, plex, roku });
  await engine.run({ id: 'x', name: 'Doorbell', steps: [{ type: 'plex', action: 'pause' }, { type: 'roku', key: 'Play' }] }, { source: 'plex', type: 'media.play', playerId: 'b', player: 'B' });
  assert.deepEqual(sent, ['relay /player/playback/pause b music']);
  assert.match(errors.join(), /Roku: the Roku refused/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'webhook', event: 'x' }, steps: [{ type: 'plex', action: 'dance' }] }), /plex step action/);
  assert.throws(() => normalizeWorkflow({ name: 'a', trigger: { source: 'webhook', event: 'x' }, steps: [{ type: 'roku' }] }), /roku step needs/);
});

test('weather: conditions, crossings, alerts (new / update / ended / outside US), workflows', async (t) => {
  assert.equal(conditionOf(0), 'clear');
  assert.equal(conditionOf(3), 'cloudy');
  assert.equal(conditionOf(63), 'rain');
  assert.equal(conditionOf(75), 'snow');
  assert.equal(conditionOf(95), 'storm');
  assert.ok(conditionIs('storm', 'rain') && !conditionIs('rain', 'storm'));
  assert.ok(readingMatches({ below: 32 }, 31, 33) && !readingMatches({ below: 32 }, 31, 31) && !readingMatches({ below: 32 }, 31, null));
  assert.ok(readingMatches({ below: 32 }, 31, 31, { crossing: false }) && !readingMatches({ above: 90 }, 85, 80));

  let now = { temperature_2m: 40, apparent_temperature: 36, relative_humidity_2m: 80, weather_code: 3, wind_speed_10m: 5, wind_gusts_10m: 12, is_day: 1 };
  let features = [];
  let outsideUs = false;
  const seen = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.pathname === '/v1/forecast' ? `wx ${url.searchParams.get('latitude')},${url.searchParams.get('longitude')} ${url.searchParams.get('temperature_unit')}` : `nws ${url.searchParams.get('point')} ${/Playlite/.test(req.headers['user-agent'])}`);
    if (url.pathname === '/v1/forecast') return res.end(JSON.stringify({ current: now, daily: { temperature_2m_max: [45], temperature_2m_min: [28] } }));
    if (url.pathname === '/alerts/active') return outsideUs ? res.writeHead(400).end('{}') : res.end(JSON.stringify({ features: features.map((p) => ({ properties: p })) }));
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { routines: [], location: { lat: 36.16218, lon: -86.77437 }, weather: { units: 'f' } };
  const log = { info() {}, warn() {}, error() {}, event() {} };
  const weather = Object.assign(new Weather(() => config, log), { weatherUrl: base, alertsUrl: base });
  const engine = new Engine({ getConfig: () => config, lights: { resolve: () => [], claim: () => new Map(), release() {} }, log, weather });
  const fired = [];
  engine.fire = (r, e) => fired.push(`${r.id}:${e.type}${e.alert ? ` ${e.alert}` : ''}`);
  weather.on('event', (e) => engine.handle(e));
  const steps = [{ type: 'wait', ms: 0 }];
  config.routines = [
    { id: 'rain', enabled: true, name: 'Rain starts', trigger: { source: 'weather', event: 'condition', to: 'rain' }, steps },
    { id: 'frost', enabled: true, name: 'Frost', trigger: { source: 'weather', event: 'reading', reading: 'temperature', below: 32 }, steps },
    { id: 'gusty', enabled: true, name: 'Gusty', trigger: { source: 'weather', event: 'reading', reading: 'gusts', above: 30 }, steps },
    { id: 'tornado', enabled: true, name: 'Tornado', trigger: { source: 'weather', event: 'alert', alert: 'tornado', severity: 'Severe' }, steps },
    { id: 'clear', enabled: true, name: 'All clear', trigger: { source: 'weather', event: 'alert.ended', alert: 'tornado' }, steps },
  ];

  await weather.pollWeather(); // first reading: nothing "changes"
  assert.equal(weather.current.condition, 'cloudy');
  assert.equal(weather.current.high, 45);
  assert.equal(seen[0], 'wx 36.16,-86.77 fahrenheit'); // rounded before it leaves the PC
  assert.deepEqual(fired, []);
  now = { ...now, temperature_2m: 31, weather_code: 63 };
  await weather.pollWeather();
  assert.deepEqual(fired, ['rain:condition', 'frost:reading']);
  now = { ...now, temperature_2m: 30, weather_code: 95, wind_gusts_10m: 40 }; // rain → storm is still rain; already below 32
  await weather.pollWeather();
  assert.deepEqual(fired, ['rain:condition', 'frost:reading', 'gusty:reading']);

  // conditions read the latest weather
  const cond = (c) => engine.blockedBy({ conditions: c });
  assert.equal(cond({ weather: { condition: 'rain' } }), null); // storm counts as rain
  assert.equal(cond({ weather: { condition: ['snow', 'clear'] } }), 'weather is storm');
  assert.equal(cond({ weather: { reading: 'temperature', below: 40 } }), null);
  assert.equal(cond({ weather: { reading: 'temperature', above: 50 } }), 'temperature is 30');

  // alerts: an old one at start-up is not announced, a fresh one is; an update isn't news; the end is
  fired.length = 0;
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  features = [
    { id: 'a1', event: 'Wind Advisory', severity: 'Moderate', headline: 'Wind Advisory until 6 PM', sent: ago(90), messageType: 'Alert' },
    { id: 't1', event: 'Tornado Warning', severity: 'Extreme', headline: 'Tornado Warning until 4:15 PM', sent: ago(2), messageType: 'Alert', instruction: 'Take cover now!' },
  ];
  const events = [];
  weather.on('event', (e) => events.push(e));
  await weather.pollAlerts();
  assert.match(seen.at(-1), /^nws 36\.162,-86\.774 true$/);
  assert.deepEqual(fired, ['tornado:alert Tornado Warning']);
  assert.equal(events[0].instruction, 'Take cover now!');
  assert.equal(weather.alerts.length, 2);
  weather.restart(); // e.g. units changed: the same alert isn't announced again
  weather.stop();
  await weather.pollAlerts();
  assert.deepEqual(fired, ['tornado:alert Tornado Warning']);
  features = [features[0], { ...features[1], id: 't2', messageType: 'Update', sent: ago(0), references: [{ identifier: 't1' }] }];
  await weather.pollAlerts();
  assert.deepEqual(fired, ['tornado:alert Tornado Warning']);
  features = [features[0], { id: 's1', event: 'Tornado Watch', severity: 'Moderate', sent: ago(0), messageType: 'Alert' }];
  await weather.pollAlerts();
  assert.deepEqual(fired, ['tornado:alert Tornado Warning', 'clear:alert.ended Tornado Warning']); // Moderate watch is below "Severe"
  outsideUs = true;
  assert.deepEqual(await weather.pollAlerts(), []);
  assert.match(weather.status.alerts, /only cover the US/);

  // validation
  const w = { name: 'w', steps };
  assert.equal(normalizeWorkflow({ ...w, trigger: { source: 'weather', event: 'reading', below: '32' } }).trigger.reading, 'temperature');
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'weather', event: 'reading', reading: 'temperature' } }), /below/);
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'weather', event: 'condition', to: 'hail' } }), /must be one of/);
  assert.equal(normalizeWorkflow({ ...w, trigger: { source: 'weather', event: 'condition', to: 'rain', forMin: 30 } }).trigger.forMin, 30);
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'weather', event: 'alert', forMin: 5 } }), /only works with/);
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'webhook', event: 'x' }, conditions: { weather: { condition: 'sunny' } } }), /must be one of/);
});

test('cameras: Frigate login, cameras, detections → triggers, snapshot in a phone alert, MCP image', async (t) => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const hits = [];
  const frigateSrv = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    if (url.pathname === '/api/login') {
      let b = '';
      req.on('data', (c) => (b += c)).on('end', () => (JSON.parse(b).password === 'pw' ? res.writeHead(200, { 'Set-Cookie': 'frigate_token=abc; Path=/; HttpOnly' }).end('{}') : res.writeHead(401).end()));
      return;
    }
    if (req.headers.cookie !== 'frigate_token=abc') return res.writeHead(401).end();
    if (url.pathname === '/api/version') return res.end('0.15.1-abc');
    if (url.pathname === '/api/config') return res.end(JSON.stringify({ cameras: { front_door: { zones: { porch: {}, walkway: {} } }, driveway: { zones: {} }, old: { enabled: false } } }));
    if (url.pathname === '/api/events/ev1/snapshot.jpg' || url.pathname === '/api/driveway/latest.jpg') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG);
    res.writeHead(404).end();
  });
  t.after(() => frigateSrv.close());
  const pushes = [];
  const ntfySrv = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    pushes.push({ method: req.method, url: req.url, filename: req.headers.filename, auth: req.headers.authorization, body: Buffer.concat(chunks) });
    res.end('{}');
  });
  t.after(() => ntfySrv.close());

  const mqtt = new EventEmitter();
  const log = { warns: [], info() {}, warn(m) { this.warns.push(m); }, error(m) { this.warns.push(m); }, event() {} };
  const config = { routines: [], ntfy: { server: `http://127.0.0.1:${ntfySrv.address().port}`, topic: 'home', token: 'tk' }, frigate: { url: `http://127.0.0.1:${frigateSrv.address().port}`, username: 'admin', password: 'pw', topicPrefix: 'frigate' } };
  const frigate = new Frigate(() => config, mqtt, log);
  await frigate.restart();
  assert.equal(frigate.status.connected, true);
  assert.equal(frigate.status.version, '0.15.1-abc');
  assert.deepEqual(frigate.cameras, [{ name: 'front_door', zones: ['porch', 'walkway'] }, { name: 'driveway', zones: [] }]);
  assert.equal(hits.filter((h) => h === '/api/login').length, 1); // logged in once, cookie reused

  const engine = new Engine({ getConfig: () => config, lights: { resolve: () => [], claim: () => new Map(), release() {} }, log, cameras: frigate });
  const fired = [];
  const realFire = engine.fire.bind(engine);
  engine.fire = (r, e) => {
    fired.push(`${r.id}:${e.type}${e.zone ? `:${e.zone}` : ''}`);
    if (r.id === 'alert') realFire(r, e);
  };
  frigate.on('event', (e) => engine.handle(e));
  const steps = [{ type: 'wait', ms: 0 }];
  config.routines = [
    { id: 'anyone', enabled: true, name: 'Person anywhere', trigger: { source: 'camera', event: 'object', label: 'person' }, steps },
    { id: 'porch', enabled: true, name: 'On the porch', trigger: { source: 'camera', event: 'object', camera: 'front', label: 'person', zone: 'porch' }, steps },
    { id: 'gone', enabled: true, name: 'Car left', trigger: { source: 'camera', event: 'object.end', label: 'car' }, steps },
    { id: 'alert', enabled: true, name: 'Snapshot', trigger: { source: 'camera', event: 'object', camera: 'front', minScore: 80 }, steps: [{ type: 'notify', title: '{{label}} at {{camera}}', message: 'Someone is here ({{score}}%)', snapshot: '' }] },
  ];
  const msg = (type, after) => mqtt.emit('event', { source: 'mqtt', topic: 'frigate/events', json: { type, after } });
  const person = { id: 'ev1', camera: 'front_door', label: 'person', top_score: 0.86, entered_zones: [], false_positive: true };
  msg('new', person); // not confirmed yet
  assert.deepEqual(fired, []);
  msg('update', { ...person, false_positive: false });
  msg('update', { ...person, false_positive: false }); // a repeat doesn't fire again
  msg('update', { ...person, false_positive: false, entered_zones: ['walkway'] });
  msg('update', { ...person, false_positive: false, entered_zones: ['walkway', 'porch'] });
  mqtt.emit('event', { source: 'mqtt', topic: 'zigbee2mqtt/x', json: { after: { id: 'zz', camera: 'front_door' } } }); // other topics ignored
  msg('new', { id: 'ev2', camera: 'driveway', label: 'car', top_score: 0.7, entered_zones: [], false_positive: false });
  msg('end', { id: 'ev2', camera: 'driveway', label: 'car' });
  msg('end', { id: 'ev9', camera: 'driveway', label: 'car' }); // never confirmed, so no "left"
  assert.deepEqual(fired, ['anyone:object', 'alert:object', 'porch:object:porch', 'gone:object.end']);
  assert.equal(frigate.recent[0].label, 'car');

  await sleep(150); // the phone alert with that detection's snapshot
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].method, 'PUT');
  assert.equal(pushes[0].auth, 'Bearer tk');
  assert.equal(pushes[0].filename, 'front_door.jpg');
  assert.deepEqual(pushes[0].body, JPEG);
  const q = new URL(pushes[0].url, 'http://x');
  assert.equal(q.pathname, '/home');
  assert.equal(q.searchParams.get('title'), 'person at front_door');
  assert.equal(q.searchParams.get('message'), 'Someone is here (86%)');

  // a snapshot that can't be fetched still sends the alert, without the picture
  await engine.sendNtfy({ message: 'hi', snapshot: 'garage' }, {});
  assert.equal(pushes[1].method, 'POST');
  assert.match(log.warns.at(-1), /no snapshot .*HTTP 404/);

  // the AI can look at a camera
  const tools = createTools({ getConfig: () => config, updateConfig: (fn) => fn(config), engine, lights: {}, frigate, log });
  const out = await handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'camera_snapshot', arguments: { camera: 'driveway' } } }, tools);
  assert.equal(out.result.content[0].type, 'image');
  assert.equal(out.result.content[0].mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(out.result.content[0].data, 'base64'), JPEG);

  // a wrong password is a clear error
  await assert.rejects(new Frigate(() => ({ frigate: { ...config.frigate, password: 'nope' } }), null, log).load(), /refused the username or password/);
  await assert.rejects(new Frigate(() => ({ frigate: { url: config.frigate.url } }), null, log).load(), /wants a login/);

  // validation
  const w = { name: 'c', steps };
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'camera', event: 'motion' } }), /object or object.end/);
  assert.throws(() => normalizeWorkflow({ ...w, trigger: { source: 'camera', event: 'object', minScore: 150 } }), /0-100/);
  assert.equal(normalizeWorkflow({ ...w, trigger: { source: 'webhook', event: 'doorbell' }, steps: [{ type: 'notify', message: 'Ding', snapshot: true }] }).steps[0].snapshot, '');
});
