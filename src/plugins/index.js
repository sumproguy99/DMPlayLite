// Integrations are plugins: one file each in this folder, listed below. A plugin is a plain object — every field is optional
// except id:
//
//   id, name
//   config          defaults, stored at config[configKey ?? id] and merged with what's saved
//   create(ctx)     → the plugin's service object. ctx: { getConfig, updateConfig, saveConfig, log, discovery, services }
//                   (services = other plugins' services, by id, created earlier in the list). late: true → created after the
//                   engine and lights exist (ctx.engine, ctx.lights).
//   start(svc) / stop(svc)   default: svc.restart?.() ?? svc.start?.() / svc.stop?.()
//   emits(svc)      → event emitters whose 'event's go to the rule engine
//   lights          { prefix, driver(svc) } — a light driver for ids "<prefix>:…"
//   trigger         { source, events, match?(t, e, opts), validate?(t), canHold?(t), subject?(e), describe?(e) }
//                   no match → the engine's generic filters (player, device, entity, to, from, button, press…)
//   condition       { has(c), check(c, svc, engine) → reason it fails | null, validate?(c) } for a key inside condition groups
//   steps           { <type>: { run(step, event, { service, engine, log }), validate?(step), label?(step) } }
//   snapshot(svc, spec, event)   → { data, name } — pictures for phone alerts
//   guide           { triggers?, conditions?, steps? } — text for the AI's WORKFLOW_GUIDE
//   tools(svc, ctx) → AI / MCP tools
//   state(svc, ctx) → keys merged into GET /api/state (ctx: { config, discovery })
//   routes(svc, ctx) → { 'METHOD /api/…': handler } for signed-in users; raw: { '/api/…': (req, res, url, ctx) } for non-JSON answers
//   keyed           { paths?, prefixes?, handle(req, res, url, ctx) } — machine endpoints that need the secret key
import hue from './hue.js';
import govee from './govee.js';
import wled from './wled.js';
import homeassistant from './homeassistant.js';
import mqtt from './mqtt.js';
import plex from './plex.js';
import roku from './roku.js';
import weather from './weather.js';
import frigate from './frigate.js';
import presence from './presence.js';
import alexa from './alexa.js';

// Order matters only for create(): a plugin can use the services of plugins listed before it.
export const PLUGINS = [hue, govee, wled, homeassistant, mqtt, plex, roku, weather, frigate, presence, alexa];

export const triggerPlugin = (source) => PLUGINS.find((p) => p.trigger?.source === source);
export const stepPlugin = (type) => PLUGINS.find((p) => p.steps?.[type]);
export const conditionPlugins = PLUGINS.filter((p) => p.condition);
export const snapshotPlugin = PLUGINS.find((p) => p.snapshot);
export const pluginStepTypes = PLUGINS.flatMap((p) => Object.keys(p.steps ?? {}));

// Fresh copies of every plugin's default settings, keyed like the config file.
export const pluginDefaults = () => Object.fromEntries(PLUGINS.filter((p) => p.config).map((p) => [p.configKey ?? p.id, structuredClone(p.config)]));

// Create every plugin's service (late ones only when { late: true }), into ctx.services.
export function createServices(ctx, { late = false } = {}) {
  ctx.services ??= {};
  for (const p of PLUGINS) {
    if (Boolean(p.late) === late && p.create) ctx.services[p.id] = p.create(ctx);
  }
  return ctx.services;
}

export const lightDrivers = (services) =>
  Object.fromEntries(PLUGINS.filter((p) => p.lights && services[p.id]).map((p) => [p.lights.prefix, p.lights.driver(services[p.id])]));

export const emitters = (services) => PLUGINS.flatMap((p) => (services[p.id] && p.emits ? p.emits(services[p.id]) : []));

export function startAll(services) {
  for (const p of PLUGINS) {
    const s = services[p.id];
    if (!s) continue;
    if (p.start) p.start(s);
    else if (s.restart) s.restart();
    else s.start?.();
  }
}

export function stopAll(services) {
  for (const p of PLUGINS) {
    const s = services[p.id];
    if (!s) continue;
    if (p.stop) p.stop(s);
    else s.stop?.();
  }
}
