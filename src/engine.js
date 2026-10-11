// Rule engine: IF (trigger) [ONLY IF (conditions)] THEN (steps).
//
// A workflow fires when its trigger OR any of its orTriggers matches.
// Trigger sources & their match fields:
//   plex           event: player.online|media.play|media.pause|media.resume|media.stop|…  player, user, mediaTypes, skipContinued
//   network        event: device.new|device.online|device.offline                      device (name/ip/mac/kind contains)
//   homeassistant  event: state                                                          entity (id/name contains), to, from
//   time           event: time.at (at "HH:MM", days [0-6]) | sun.sunrise | sun.sunset (offsetMin)   — fired by the scheduler
//   webhook        event: <name>   (/hooks/<name>, Siri Shortcuts, IFTTT, Zapier, HA rest_command…)
//   voice          event: alexa    device (exposed name contains)
//   mode           event: mode.changed  to, from (house mode names)
// Conditions: timeWindow {from,to} · dark · fullMoon · presence {device, state: home|away} · mode (name or list) · cooldownSec
// Steps: set · pulse · wait · http {method,url,body,headers} · ha {service, data} · notify {message, title, topic, priority, tags, click} · mode {mode}
import { Token, contains, sleep } from './util.js';
import { isDark, isFullMoon } from './solar.js';

// A workflow has one main trigger plus optional orTriggers — any of them starts it.
export const triggersOf = (routine) => [routine.trigger, ...(routine.orTriggers ?? [])].filter(Boolean);
// "…and it stays that way for N minutes" — only for triggers that describe a state that can end.
export const HOLD_SOURCES = ['plex', 'network', 'homeassistant', 'mode'];
export const canHold = (t) => HOLD_SOURCES.includes(t?.source) && !['device.new', 'media.scrobble'].includes(t.event);
// What an event is about: one HA entity, one network device, one Plex player (player vs media state), the house mode.
export const subjectOf = (e) => `${e.source}|${String(e.type).split('.')[0]}|${e.entity ?? e.mac ?? e.playerId ?? e.player ?? e.device ?? ''}`;
export const hasConditions = (c) => Boolean(c && (c.timeWindow || c.dark || c.light || c.fullMoon || c.mode?.length || c.presence?.device));
// Condition groups that actually check something: "conditions" OR any of "orConditions".
export const conditionGroups = (routine) => [routine.conditions, ...(routine.orConditions ?? [])].filter(hasConditions);

export function matchesTrigger(trigger, event) {
  if (!trigger || trigger.source !== event.source || trigger.event !== event.type) return false;
  if (trigger.player && !contains(event.player, trigger.player)) return false;
  if (trigger.user && !contains(event.user, trigger.user)) return false;
  if (trigger.mediaTypes?.length && event.mediaType && !trigger.mediaTypes.includes(event.mediaType)) return false;
  if (trigger.skipContinued && event.continued) return false;
  if (trigger.device && !contains([event.device, event.ip, event.mac, event.kind, event.label].join(' '), trigger.device)) return false;
  if (trigger.entity && !contains(`${event.entity} ${event.name}`, trigger.entity)) return false;
  if (trigger.to && String(event.to).toLowerCase() !== String(trigger.to).toLowerCase()) return false;
  if (trigger.from && String(event.from).toLowerCase() !== String(trigger.from).toLowerCase()) return false;
  return true;
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

export function withinTimeWindow(window, now = new Date()) {
  if (!window?.from || !window?.to) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to; // handles overnight windows
}

// "{{player}} started {{title}}" -> values from the triggering event.
export function template(value, event) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(k.split('.').reduce((o, p) => o?.[p], event) ?? ''));
  if (Array.isArray(value)) return value.map((v) => template(v, event));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, event)]));
  return value;
}

// ntfy publish request for a notify step. The step's topic overrides the default from Connections.
export function ntfyRequest(step, settings = {}, event = {}) {
  const topic = String(template(step.topic || settings.topic || '', event)).trim();
  if (!topic) throw new Error('no ntfy topic — set one under Connections → Phone alerts');
  const tags = template(step.tags ?? '', event);
  const body = {
    topic,
    message: template(step.message || 'Playlite', event),
    ...(step.title ? { title: template(step.title, event) } : {}),
    ...(step.priority ? { priority: Number(step.priority) } : {}),
    ...(tags ? { tags: (Array.isArray(tags) ? tags : String(tags).split(',')).map((t) => t.trim()).filter(Boolean) } : {}),
    ...(step.click ? { click: template(step.click, event) } : {}),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  const server = (settings.server || 'https://ntfy.sh').replace(/\/+$/, '');
  return { url: server, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

const LIGHT_STEPS = new Set(['set', 'pulse']);

export class Engine {
  #lastRun = new Map(); // routine id -> timestamp

  #modeChanges = []; // timestamps, to stop workflows flipping the mode back and forth forever
  #holds = new Map(); // routine|trigger|subject -> { timer, trigger, subject, name } for "for N minutes" triggers

  constructor({ getConfig, updateConfig = (fn) => fn(getConfig()), lights, log, discovery = null, ha = null }) {
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.lights = lights;
    this.log = log;
    this.discovery = discovery;
    this.ha = ha;
  }

  // House mode: one current mode (home, away, movie…). Changing it fires { source: 'mode', type: 'mode.changed', from, to }.
  get mode() {
    return this.getConfig().mode ?? 'home';
  }

  // byWorkflow: changes made by a workflow step count toward the loop guard; a person (UI, Siri, AI) always wins and resets it.
  setMode(mode, by = 'manual', { byWorkflow = false } = {}) {
    const to = String(mode ?? '').trim().toLowerCase();
    const modes = this.getConfig().modes ?? [];
    if (!modes.includes(to)) throw new Error(`Unknown mode "${mode}" — use one of: ${modes.join(', ')}`);
    const from = this.mode;
    if (from === to) return false;
    const now = Date.now();
    if (byWorkflow) {
      this.#modeChanges = this.#modeChanges.filter((t) => now - t < 10_000);
      if (this.#modeChanges.length >= 10) throw new Error('Mode changed 10 times in 10 seconds — two workflows are probably switching it back and forth');
      this.#modeChanges.push(now);
    } else this.#modeChanges = [];
    this.updateConfig((c) => (c.mode = to));
    this.handle({ source: 'mode', type: 'mode.changed', from, to, by, at: new Date().toISOString() });
    return true;
  }

  handle(event) {
    const desc = [event.type, event.source === 'mode' && `${event.from} → ${event.to}${event.by ? ` (by ${event.by})` : ''}`,event.player && `on "${event.player}"`, event.device && `"${event.device}"`, event.entity && `${event.entity}: ${event.from} → ${event.to}`, event.title && `(${event.title})`]
      .filter(Boolean)
      .join(' ');
    if (!event.quiet) this.log.event(`${event.source}: ${desc}`, event);
    // A later event about the same thing that no longer matches ends a "for N minutes" wait.
    const subject = subjectOf(event);
    for (const [key, h] of this.#holds) {
      if (h.subject !== subject || event.type === 'media.scrobble' || matchesTrigger(h.trigger, event)) continue;
      clearTimeout(h.timer);
      this.#holds.delete(key);
      this.log.info(`⏹ "${h.name}" stopped waiting — it changed before ${h.trigger.forMin} min`);
    }
    for (const routine of this.getConfig().routines) {
      if (!routine.enabled) continue;
      const matched = triggersOf(routine).map((t, i) => [t, i]).filter(([t]) => matchesTrigger(t, event));
      if (!matched.length) continue;
      if (matched.some(([t]) => !(t.forMin > 0 && canHold(t)))) this.fire(routine, event);
      else this.#hold(routine, ...matched[0], event, subject);
    }
  }

  // Start (or keep) a "for N minutes" wait; when it runs out the workflow fires as if the event just happened.
  #hold(routine, trigger, i, event, subject) {
    const key = `${routine.id}|${i}|${subject}`;
    if (this.#holds.has(key)) return; // already waiting — keep the original start time
    const timer = setTimeout(() => {
      this.#holds.delete(key);
      const current = this.getConfig().routines.find((r) => r.id === routine.id);
      // skip if the workflow was turned off, deleted, or its trigger edited meanwhile
      if (!current?.enabled || JSON.stringify(triggersOf(current)[i]) !== JSON.stringify(trigger)) return;
      this.fire(current, { ...event, heldMin: trigger.forMin });
    }, trigger.forMin * 60_000);
    timer.unref?.();
    this.#holds.set(key, { timer, trigger, subject, name: routine.name });
    this.log.info(`⏳ "${routine.name}" runs if it stays that way for ${trigger.forMin} min`);
  }

  // Workflows currently waiting out a "for N minutes" trigger.
  get waiting() {
    return [...this.#holds.values()].map((h) => ({ name: h.name, forMin: h.trigger.forMin, subject: h.subject.split('|')[2] }));
  }

  // Check conditions + cooldown, then run. Used by handle() and by the scheduler.
  fire(routine, event) {
    const why = this.blockedBy(routine);
    if (why) {
      this.log.info(`Skipped "${routine.name}" (${why})`);
      return false;
    }
    const last = this.#lastRun.get(routine.id) ?? 0;
    if (routine.cooldownSec && Date.now() - last < routine.cooldownSec * 1000) {
      this.log.info(`Skipped "${routine.name}" (cooldown)`);
      return false;
    }
    this.run(routine, event);
    return true;
  }

  // Returns a reason string if the conditions fail, else null.
  // "conditions" and each "orConditions" group is an AND of its checks; any passing group lets the workflow run.
  blockedBy(routine, now = new Date()) {
    const groups = conditionGroups(routine);
    if (!groups.length) return null;
    const reasons = [];
    for (const c of groups) {
      const why = this.#groupBlockedBy(c, now);
      if (!why) return null;
      reasons.push(why);
    }
    return [...new Set(reasons)].join(' / ');
  }

  #groupBlockedBy(c, now) {
    if (!withinTimeWindow(c.timeWindow, now)) return `outside ${c.timeWindow.from}–${c.timeWindow.to}`;
    const loc = this.getConfig().location;
    if ((c.dark || c.light) && !loc?.lat) return 'set your location to use day/night conditions';
    if (c.dark && !isDark(now, loc.lat, loc.lon)) return 'it is daytime';
    if (c.light && isDark(now, loc.lat, loc.lon)) return 'it is dark';
    if (c.fullMoon && !isFullMoon(now)) return 'not a full moon';
    if (c.mode?.length && ![c.mode].flat().includes(this.mode)) return `mode is ${this.mode}`;
    if (c.presence?.device && this.discovery) {
      const home = this.discovery.find(c.presence.device).some((d) => d.online);
      if (c.presence.state === 'home' && !home) return `${c.presence.device} is away`;
      if (c.presence.state === 'away' && home) return `${c.presence.device} is home`;
    }
    return null;
  }

  async run(routine, event = { source: 'manual', type: 'run' }) {
    this.#lastRun.set(routine.id, Date.now());
    const stepTargets = (step) => this.lights.resolve(step.targets?.length ? step.targets : routine.targets);
    const lightSteps = routine.steps.filter((s) => LIGHT_STEPS.has(s.type));
    const all = [...new Set(lightSteps.flatMap(stepTargets))];

    if (lightSteps.length && !all.length) {
      this.log.warn(`"${routine.name}" matched but has no lights — add lights to its group/targets`);
      if (lightSteps.length === routine.steps.filter((s) => s.type !== 'wait').length) return;
    }

    const tokens = this.lights.claim(all);
    // The run stops once every light it controls was taken over by another workflow.
    const runToken = new Token();
    for (const t of tokens.values()) t.onCancel(() => [...tokens.values()].every((x) => x.cancelled) && runToken.cancel());

    const n = all.length;
    this.log.info(`▶ ${routine.name}${n ? `  [${n} light${n > 1 ? 's' : ''}]` : ''}`, { routine: routine.id, trigger: event.type });
    const started = Date.now();
    try {
      for (const step of routine.steps) {
        if (runToken.cancelled) break;
        if (step.type === 'wait') await sleep(step.ms ?? 0, runToken);
        else if (step.type === 'http') await this.#http(step, event);
        else if (step.type === 'ha') await this.#ha(step, event);
        else if (step.type === 'notify') await this.#notify(step, event);
        else if (step.type === 'mode') this.#modeStep(step, routine);
        else if (LIGHT_STEPS.has(step.type)) {
          const live = stepTargets(step).filter((t) => !tokens.get(t)?.cancelled);
          await Promise.all(live.map((t) => this.#lightStep(step, t, tokens.get(t))));
        } else this.log.warn(`Unknown step type "${step.type}"`);
      }
      const note = runToken.cancelled ? ' (taken over by another workflow)' : '';
      this.log.info(`■ ${routine.name} done in ${((Date.now() - started) / 1000).toFixed(1)}s${note}`);
    } finally {
      this.lights.release(tokens);
    }
  }

  async #lightStep(step, target, token) {
    try {
      if (step.type === 'set') {
        const { brightness, kelvin, color, on } = step;
        await this.lights.set(target, { brightness, kelvin, color, on }, step.transitionMs ?? 0, token);
      } else {
        await this.lights.pulse(target, step, token);
      }
    } catch (err) {
      this.log.error(`${target}: ${err.message}`);
    }
  }

  async #http(step, event) {
    const url = template(step.url, event);
    const method = (step.method ?? 'POST').toUpperCase();
    try {
      let body = step.body == null || method === 'GET' ? undefined : template(step.body, event);
      const headers = { ...template(step.headers ?? {}, event) };
      if (body && typeof body === 'object') {
        body = JSON.stringify(body);
        headers['Content-Type'] ??= 'application/json';
      }
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) this.log.warn(`Call ${method} ${url} → HTTP ${res.status}`);
      else this.log.info(`Called ${method} ${new URL(url).host} → ${res.status}`);
    } catch (err) {
      this.log.error(`Call ${method} ${url} failed: ${err.message}`);
    }
  }

  // Throws on failure — the Connections "Send test" button shows the error.
  async sendNtfy(step, event = {}) {
    const { url, init } = ntfyRequest(step, this.getConfig().ntfy, event);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }).catch((err) => {
      throw new Error(`can't reach ${url} (${err.cause?.code ?? err.message})`);
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the access token)' : ''}`);
    this.log.info(`Phone alert sent → ${JSON.parse(init.body).topic}`);
  }

  async #notify(step, event) {
    try {
      await this.sendNtfy(step, event);
    } catch (err) {
      this.log.error(`Phone alert failed: ${err.message}`);
    }
  }

  #modeStep(step, routine) {
    try {
      if (this.setMode(step.mode, routine.name, { byWorkflow: true })) this.log.info(`Mode → ${step.mode}`);
    } catch (err) {
      this.log.error(err.message);
    }
  }

  async #ha(step, event) {
    try {
      if (!this.ha) throw new Error('Home Assistant is not set up');
      await this.ha.callService(step.service, template(step.data ?? {}, event));
      this.log.info(`Home Assistant: ${step.service}`);
    } catch (err) {
      this.log.error(`Home Assistant ${step.service}: ${err.message}`);
    }
  }
}
