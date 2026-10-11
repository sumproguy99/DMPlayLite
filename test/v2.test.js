import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sunTimes, moonPhase, isFullMoon } from '../src/solar.js';
import { Auth } from '../src/auth.js';
import { handleMcp } from '../src/mcp.js';
import { createTools, normalizeWorkflow } from '../src/tools.js';
import { Engine, matchesTrigger, template } from '../src/engine.js';
import { nextFireToday } from '../src/scheduler.js';
import { classify, vendorFor, pickName } from '../src/discovery.js';
import { encodeQuery, decodePacket } from '../src/dns.js';

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
