import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pulseSequence, rgbToXy, kelvinToMired, sleep, Token } from '../src/util.js';
import { matchesTrigger, withinTimeWindow, Engine } from '../src/engine.js';
import { diffSessions } from '../src/integrations/plex.js';
import { LightController } from '../src/lights.js';

test('pulse sequence collapses repeated levels', () => {
  assert.deepEqual(pulseSequence([100, 70, 100], 2), [100, 70, 100, 70, 100]);
  assert.equal(pulseSequence([100, 70, 100], 5).length, 11);
});

test('color conversions', () => {
  assert.equal(kelvinToMired(4000), 250);
  assert.equal(kelvinToMired(1000), 500);
  const [x, y] = rgbToXy({ r: 255, g: 0, b: 0 });
  assert.ok(x > 0.6 && y < 0.35);
});

test('trigger matching', () => {
  const tr = { source: 'plex', event: 'media.play', player: 'living room', mediaTypes: ['movie', 'episode'], skipContinued: true };
  const ev = { source: 'plex', type: 'media.play', player: 'Living Room TV', mediaType: 'movie' };
  assert.ok(matchesTrigger(tr, ev));
  assert.ok(!matchesTrigger(tr, { ...ev, player: 'Bedroom' }));
  assert.ok(!matchesTrigger(tr, { ...ev, mediaType: 'track' }));
  assert.ok(!matchesTrigger(tr, { ...ev, continued: true }));
  assert.ok(!matchesTrigger(tr, { ...ev, type: 'media.pause' }));
});

test('time windows, including overnight', () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(withinTimeWindow({ from: '18:00', to: '06:00' }, at(23)));
  assert.ok(withinTimeWindow({ from: '18:00', to: '06:00' }, at(2)));
  assert.ok(!withinTimeWindow({ from: '18:00', to: '06:00' }, at(12)));
  assert.ok(withinTimeWindow({ from: '09:00', to: '17:00' }, at(12)));
  assert.ok(withinTimeWindow(undefined, at(12)));
});

test('session diff: buffering start, pause, resume, stop', () => {
  const snap = (state) => new Map([['1', { state, player: 'TV', playerId: 'p1', mediaType: 'movie', title: 'X', announced: undefined }]]);
  const s0 = new Map();
  const s1 = snap('buffering');
  assert.deepEqual(diffSessions(s0, s1).map((e) => e.type), []);
  const s2 = snap('playing');
  assert.deepEqual(diffSessions(s1, s2).map((e) => e.type), ['media.play']);
  const s3 = snap('paused');
  assert.deepEqual(diffSessions(s2, s3).map((e) => e.type), ['media.pause']);
  const s4 = snap('buffering');
  assert.deepEqual(diffSessions(s3, s4).map((e) => e.type), []);
  const s5 = snap('playing');
  assert.deepEqual(diffSessions(s4, s5).map((e) => e.type), ['media.resume']);
  assert.deepEqual(diffSessions(s5, new Map()).map((e) => e.type), ['media.stop']);
});

// Fake driver that records commands, used to test fades/pulses/cancellation end to end.
function fakeSetup(supportsTransition) {
  const calls = [];
  const driver = {
    supportsTransition,
    list: async () => [],
    apply: async (ref, p, t) => calls.push({ ref, ...p, t }),
    setBrightness: async (ref, b) => calls.push({ ref, brightness: b, soft: true }),
    getState: async () => ({ on: true, brightness: 50 }),
  };
  const config = { groups: [{ id: 'den', members: ['fake:a', 'fake:b'] }], routines: [] };
  const log = { info() {}, warn() {}, error() {}, event() {} };
  const lights = new LightController({ drivers: { fake: driver }, getConfig: () => config, log });
  const engine = new Engine({ getConfig: () => config, lights, log });
  return { calls, lights, engine, config };
}

test('group resolution', () => {
  const { lights } = fakeSetup(true);
  assert.deepEqual(lights.resolve(['group:den', 'fake:a', 'fake:c']), ['fake:a', 'fake:b', 'fake:c']);
});

test('software fade steps brightness to target', async () => {
  const { calls, lights } = fakeSetup(false);
  await lights.set('fake:a', { brightness: 10 }, 600);
  const soft = calls.filter((c) => c.soft).map((c) => c.brightness);
  assert.ok(soft.length >= 3, `expected several steps, got ${soft}`);
  assert.equal(soft.at(-1), 10);
  assert.ok(soft.every((b, i) => i === 0 || b <= soft[i - 1]), 'monotonic fade down');
});

test('a new routine interrupts a running fade on the same light', async () => {
  const { calls, engine, config } = fakeSetup(false);
  const dim = { id: 'dim', name: 'dim', enabled: true, trigger: { source: 'plex', event: 'media.play' }, targets: ['fake:a'], steps: [{ type: 'set', brightness: 0, transitionMs: 3000 }] };
  const up = { id: 'up', name: 'up', enabled: true, trigger: { source: 'plex', event: 'media.pause' }, targets: ['fake:a'], steps: [{ type: 'set', brightness: 70, transitionMs: 0 }] };
  config.routines.push(dim, up);
  const first = engine.run(dim);
  await sleep(400);
  await engine.run(up);
  await first;
  const last = calls.at(-1);
  assert.equal(last.brightness, 70, 'interrupted fade must not keep writing after takeover');
  assert.ok(calls.filter((c) => c.soft).length < 10);
});

test('hue-style pulse issues one transition per level', async () => {
  const { calls, lights } = fakeSetup(true);
  await lights.pulse('fake:a', { levels: [100, 70, 100], times: 2, stepMs: 10 }, new Token());
  assert.deepEqual(calls.map((c) => c.brightness), [100, 70, 100, 70, 100]);
  assert.ok(calls.every((c) => c.t === 10));
});
