// Tools that AI agents can use — shared by the MCP server (/mcp) and the built-in Claude assistant.
import { randomId } from './util.js';
import { hasConditions, canHold } from './engine.js';

export const WORKFLOW_GUIDE = `A Playlite workflow is JSON:
{
  "name": "Short descriptive name",
  "enabled": true,
  "voiceName": "Movie Mode",            // optional: exposes it to Alexa ("Alexa, turn on Movie Mode")
  "trigger": { "source": ..., "event": ..., ...filters },
  "orTriggers": [ { ... } ],             // optional: more triggers, same shape — any one of them starts the workflow
  "conditions": { ... },                 // optional: every check in it must pass
  "orConditions": [ { ... } ],           // optional: alternative condition groups — the workflow runs if "conditions" OR any of these passes
  "cooldownSec": 0,                      // optional: minimum seconds between runs
  "targets": ["group:living-room"],      // default lights for light steps (ids from list_lights)
  "steps": [ ... ]
}
TRIGGERS (source → event → optional filters):
- plex → player.online | player.offline | media.play | media.pause | media.resume | media.stop | media.scrobble.
  Filters: player (device name contains), user, mediaTypes ["movie","episode","clip","track"], skipContinued (ignore next-episode autoplay).
- network → device.new (never-seen device joined) | device.online | device.offline. Filter: device (name/ip/mac/kind contains, e.g. "iPhone").
- homeassistant → state. Filters: entity (entity_id or name contains), to (new state, e.g. "on", "open", "home"), from.
- time → time.at (with "at": "HH:MM", optional "days": [0-6], 0=Sunday) | sun.sunrise | sun.sunset (optional "offsetMin", negative = before).
- webhook → any name, fired by GET/POST /hooks/<name>?key=… (Siri Shortcuts, IFTTT, Zapier, Home Assistant).
- voice → alexa. Filter: device (spoken device name).
- mode → mode.changed (the house mode was switched). Filters: to, from (mode names, see get_mode).
- mqtt → message. "topic" (MQTT wildcards + and # allowed, see mqtt_topics) and EITHER "payload" (whole message equals, e.g. "ON")
  OR "field" (JSON key, dots for nesting) with optional "value" — a field trigger fires when that field CHANGES (to "value").
  Zigbee2MQTT motion: {"source":"mqtt","event":"message","topic":"zigbee2mqtt/Hall motion","field":"occupancy","value":"true"}
  No motion for 10 min: same with "value":"false","forMin":10. Templates: {{topic}}, {{payload}}, {{json.temperature}}.
"forMin": N on a plex, network, homeassistant, mode or mqtt trigger = only if it STAYS that way for N minutes
  (e.g. door open 10 min: {"source":"homeassistant","event":"state","entity":"front_door","to":"on","forMin":10};
  phone gone 30 min: {"source":"network","event":"device.offline","device":"iPhone","forMin":30}). Waits reset on restart.
CONDITIONS: timeWindow {"from":"HH:MM","to":"HH:MM"} · dark: true (after sunset/before sunrise) · light: true · fullMoon: true ·
  presence {"device": "iPhone", "state": "home"|"away"} · mode: "movie" or ["movie","sleep"] (current house mode is one of these).
  Checks inside one group are AND. For OR use orConditions, e.g. "after dark OR in movie mode" →
  "conditions": {"dark": true}, "orConditions": [{"mode": "movie"}].
STEPS:
- {"type":"set","brightness":0-100,"kelvin":2200-6500,"color":"#rrggbb","transitionMs":5000,"targets":[optional override]}  (brightness 0 = off; "natural light" ≈ 4000K, warm ≈ 2700K)
- {"type":"pulse","levels":[100,70,100],"times":5,"stepMs":1000,"restore":true}
- {"type":"wait","ms":2000}
- {"type":"http","method":"POST","url":"https://…","body":{…}}   (strings may use {{player}}, {{title}}, {{device}}, {{entity}}, {{to}} from the event)
- {"type":"ha","service":"switch.turn_on","data":{"entity_id":"switch.fan"}}
- {"type":"notify","message":"{{title}} started","title":"Movie time","priority":3,"tags":"movie_camera","click":"https://…"}  (phone push via ntfy; optional "topic" overrides the default set under Connections; priority 1-5, 5 = urgent)
- {"type":"mode","mode":"movie"}   (switch the house mode; this can trigger other workflows)
- {"type":"mqtt","topic":"zigbee2mqtt/Lamp/set","payload":{"state":"ON"},"retain":false}   (publish; payload may be text or JSON, {{variables}} work)
- {"type":"capture","scene":"Before movie","targets":[optional override]}   (save how the lights look right now as a scene; same name = replace)
- {"type":"scene","scene":"Before movie","transitionMs":3000}   (put the lights back the way that scene saved them; see list_scenes)
SCENES remember brightness + white temperature or color per light. "Remember how the room was and restore it after the movie" =
  movie-start workflow: capture "Before movie" FIRST, then dim; movie-stop workflow: scene "Before movie".`;

export function normalizeWorkflow(w) {
  if (!w || typeof w !== 'object') throw new Error('Workflow must be an object');
  if (!w.name) throw new Error('Workflow needs a name');
  if (!w.trigger?.source || !w.trigger?.event) throw new Error('Workflow needs trigger.source and trigger.event');
  if (w.orTriggers != null && !Array.isArray(w.orTriggers)) throw new Error('orTriggers must be a list of triggers');
  if (w.orTriggers?.some((t) => !t?.source || !t?.event)) throw new Error('Every extra trigger needs a source and an event');
  if (w.orTriggers && !w.orTriggers.length) delete w.orTriggers;
  if ([w.trigger, ...(w.orTriggers ?? [])].some((t) => t.source === 'mqtt' && !String(t.topic ?? '').trim())) throw new Error('MQTT trigger needs a topic');
  for (const t of [w.trigger, ...(w.orTriggers ?? [])]) {
    if (t.forMin == null || t.forMin === '' || t.forMin === 0) {
      delete t.forMin;
      continue;
    }
    if (!(Number(t.forMin) > 0)) throw new Error('forMin must be a positive number of minutes');
    if (!canHold(t)) throw new Error(`"for N minutes" only works with Plex, network, Home Assistant and house-mode triggers (not ${t.source} ${t.event})`);
    t.forMin = Number(t.forMin);
  }
  if (w.orConditions != null && !Array.isArray(w.orConditions)) throw new Error('orConditions must be a list of condition groups');
  if (w.orConditions) {
    w.orConditions = w.orConditions.filter(hasConditions);
    if (!w.orConditions.length) delete w.orConditions;
  }
  if (!Array.isArray(w.steps) || !w.steps.length) throw new Error('Workflow needs at least one step');
  for (const s of w.steps) {
    if (!['set', 'pulse', 'wait', 'http', 'ha', 'notify', 'mode', 'scene', 'capture', 'mqtt'].includes(s.type)) throw new Error(`Unknown step type "${s.type}"`);
    if (s.type === 'pulse') {
      s.levels ??= [100, 70, 100];
      s.times ??= 3;
      s.stepMs ??= 1000;
    }
    if (s.type === 'http' && !/^https?:\/\//.test(s.url ?? '')) throw new Error('http step needs a full http(s) URL');
    if (s.type === 'ha' && !/^\w+\.\w+$/.test(s.service ?? '')) throw new Error('ha step needs a service like "light.turn_on"');
    if (s.type === 'mode' && !String(s.mode ?? '').trim()) throw new Error('mode step needs a mode, e.g. "movie"');
    if (s.type === 'mqtt' && (!String(s.topic ?? '').trim() || /[+#]/.test(s.topic))) throw new Error('mqtt step needs a plain topic (no + or # wildcards)');
    if ((s.type === 'scene' || s.type === 'capture') && !String(s.scene ?? '').trim()) throw new Error(`${s.type} step needs a scene name`);
    if (s.type === 'notify') {
      if (!String(s.message ?? '').trim()) throw new Error('notify step needs a message');
      if (s.priority != null && s.priority !== '' && !(Number.isInteger(+s.priority) && +s.priority >= 1 && +s.priority <= 5)) throw new Error('notify priority must be 1-5');
      if (s.click && !/^https?:\/\//.test(s.click)) throw new Error('notify click link needs a full http(s) URL');
    }
  }
  return { id: w.id || randomId(4), enabled: w.enabled ?? true, targets: w.targets ?? [], ...w };
}

export function createTools(ctx) {
  const { getConfig, updateConfig, engine, lights, discovery, ha, mqtt, log } = ctx;
  const findRoutine = (q) => {
    const rs = getConfig().routines;
    const s = String(q ?? '').toLowerCase();
    return rs.find((r) => r.id === q) ?? rs.find((r) => r.name.toLowerCase() === s || r.voiceName?.toLowerCase() === s) ?? rs.find((r) => r.name.toLowerCase().includes(s));
  };

  const tools = [
    {
      name: 'list_lights',
      description: 'List every controllable light (Hue, Govee, Home Assistant) and every Playlite group, with the ids to use as targets.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({
        groups: getConfig().groups.map((g) => ({ id: `group:${g.id}`, name: g.name, lights: g.members.length })),
        lights: (await lights.list()).map(({ id, name, kind }) => ({ id, name, kind })),
      }),
    },
    {
      name: 'set_lights',
      description: 'Change lights right now. Targets are ids from list_lights (e.g. "group:basement"). brightness 0 turns off.',
      inputSchema: {
        type: 'object',
        properties: {
          targets: { type: 'array', items: { type: 'string' } },
          brightness: { type: 'number', minimum: 0, maximum: 100 },
          kelvin: { type: 'number', minimum: 2000, maximum: 6500 },
          color: { type: 'string', description: 'Hex color like #ff8800' },
          transition_seconds: { type: 'number', minimum: 0 },
        },
        required: ['targets'],
        additionalProperties: false,
      },
      run: async (a) => {
        engine.run(
          { id: `agent-${randomId(3)}`, name: 'AI: set lights', targets: a.targets, steps: [{ type: 'set', brightness: a.brightness, kelvin: a.kelvin, color: a.color, transitionMs: (a.transition_seconds ?? 1) * 1000 }] },
          { source: 'agent', type: 'set_lights' },
        );
        return { ok: true, lights: lights.resolve(a.targets).length };
      },
    },
    {
      name: 'list_workflows',
      description: 'List all workflows (IF this THEN that rules) with their ids, triggers and whether they are enabled.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => getConfig().routines.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, voiceName: r.voiceName, trigger: r.trigger, orTriggers: r.orTriggers, conditions: r.conditions, orConditions: r.orConditions, steps: r.steps.length })),
    },
    {
      name: 'get_workflow',
      description: 'Get the full JSON of one workflow by id or name.',
      inputSchema: { type: 'object', properties: { workflow: { type: 'string' } }, required: ['workflow'], additionalProperties: false },
      run: async (a) => findRoutine(a.workflow) ?? { error: 'Not found' },
    },
    {
      name: 'run_workflow',
      description: 'Run a workflow immediately (ignores its trigger and conditions).',
      inputSchema: { type: 'object', properties: { workflow: { type: 'string', description: 'Workflow id or name' } }, required: ['workflow'], additionalProperties: false },
      run: async (a) => {
        const r = findRoutine(a.workflow);
        if (!r) return { error: `No workflow matching "${a.workflow}"` };
        engine.run(r, { source: 'agent', type: 'run' });
        return { ok: true, ran: r.name };
      },
    },
    {
      name: 'save_workflow',
      description: `Create a new workflow, or replace an existing one when "id" is given. Saved and active immediately.\n\n${WORKFLOW_GUIDE}`,
      inputSchema: { type: 'object', properties: { workflow: { type: 'object' } }, required: ['workflow'], additionalProperties: false },
      run: async (a) => {
        const w = normalizeWorkflow(a.workflow);
        updateConfig((c) => {
          const i = c.routines.findIndex((r) => r.id === w.id);
          if (i >= 0) c.routines[i] = w;
          else c.routines.push(w);
        });
        log.info(`AI saved workflow "${w.name}"`);
        return { ok: true, id: w.id };
      },
    },
    {
      name: 'set_workflow_enabled',
      description: 'Turn a workflow on or off.',
      inputSchema: { type: 'object', properties: { workflow: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['workflow', 'enabled'], additionalProperties: false },
      run: async (a) => {
        const r = findRoutine(a.workflow);
        if (!r) return { error: 'Not found' };
        updateConfig(() => (r.enabled = a.enabled));
        return { ok: true, name: r.name, enabled: a.enabled };
      },
    },
    {
      name: 'delete_workflow',
      description: 'Delete a workflow permanently.',
      inputSchema: { type: 'object', properties: { workflow: { type: 'string' } }, required: ['workflow'], additionalProperties: false },
      run: async (a) => {
        const r = findRoutine(a.workflow);
        if (!r) return { error: 'Not found' };
        updateConfig((c) => (c.routines = c.routines.filter((x) => x.id !== r.id)));
        return { ok: true, deleted: r.name };
      },
    },
    {
      name: 'get_mode',
      description: 'The current house mode (e.g. home, away, movie, sleep, guest) and the list of available modes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({ mode: engine.mode, modes: getConfig().modes }),
    },
    {
      name: 'set_mode',
      description: 'Switch the house mode. Workflows triggered by mode changes run, and workflows with a mode condition start/stop applying.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false },
      run: async (a) => ({ ok: true, changed: engine.setMode(a.mode, 'AI'), mode: engine.mode }),
    },
    {
      name: 'list_scenes',
      description: 'Saved light scenes (name and how many lights each covers).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => (getConfig().scenes ?? []).map((s) => ({ id: s.id, name: s.name, lights: Object.keys(s.lights).length, savedAt: s.savedAt })),
    },
    {
      name: 'save_scene',
      description: 'Save how the given lights look right now as a named scene (same name replaces it). targets are light/group ids from list_lights.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } } }, required: ['name', 'targets'], additionalProperties: false },
      run: async (a) => {
        const { scene, skipped } = await engine.saveScene(a.name, a.targets);
        return { ok: true, scene: scene.name, lights: Object.keys(scene.lights).length, unreachable: skipped };
      },
    },
    {
      name: 'apply_scene',
      description: 'Set the lights back to a saved scene, optionally fading over transitionMs.',
      inputSchema: { type: 'object', properties: { scene: { type: 'string' }, transitionMs: { type: 'number' } }, required: ['scene'], additionalProperties: false },
      run: async (a) => ({ ok: true, scene: (await engine.applyScene(a.scene, a.transitionMs ?? 0)).name }),
    },
    {
      name: 'mqtt_topics',
      description: 'MQTT topics seen recently on the broker, newest first, with their last message (use to find Zigbee2MQTT / Tasmota / Frigate topics and JSON fields). Optional text filter.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      run: async (a) => {
        if (!mqtt?.status.connected) throw new Error('MQTT is not connected — set it up under Connections → MQTT');
        return mqtt.recent(a.query ?? '').slice(0, 60);
      },
    },
    {
      name: 'mqtt_publish',
      description: 'Publish an MQTT message, e.g. topic "zigbee2mqtt/Lamp/set" payload {"state":"TOGGLE"}, or "cmnd/plug/POWER" payload "ON".',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' }, payload: {}, retain: { type: 'boolean' } }, required: ['topic'], additionalProperties: false },
      run: async (a) => {
        if (!mqtt) throw new Error('MQTT is not set up');
        mqtt.publish(a.topic, a.payload, { retain: a.retain });
        return { ok: true };
      },
    },
    {
      name: 'list_network_devices',
      description: 'Devices Playlite has discovered on the home network (phones, TVs, cameras, speakers, hubs…) and whether they are online now. Optional text filter.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      run: async (a) => (a.query ? discovery.find(a.query) : discovery.list())
        .slice(0, 80)
        .map((d) => ({ name: d.name ?? d.hostname ?? d.ip, kind: d.label, ip: d.ip, online: d.online, lastSeen: d.lastSeen })),
    },
    {
      name: 'recent_activity',
      description: 'Recent Playlite events and workflow runs (newest last).',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
      run: async (a) => log.entries.slice(-(a.limit ?? 30)).map((e) => `${e.at.slice(11, 19)} ${e.level}: ${e.message}`),
    },
    {
      name: 'home_assistant_entities',
      description: 'Search Home Assistant entities (needs the Home Assistant connection). Optional domain like "light", "switch", "sensor", "climate", "lock", "person".',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string' } }, additionalProperties: false },
      run: async (a) => (ha?.status.connected ? ha.entities(a.query ?? '', a.domain ?? '').slice(0, 100) : { error: 'Home Assistant is not connected' }),
    },
    {
      name: 'home_assistant_call',
      description: 'Call any Home Assistant service, e.g. service "climate.set_temperature" with data {"entity_id":"climate.house","temperature":70}.',
      inputSchema: { type: 'object', properties: { service: { type: 'string' }, data: { type: 'object' } }, required: ['service'], additionalProperties: false },
      run: async (a) => {
        await ha.callService(a.service, a.data ?? {});
        return { ok: true };
      },
    },
    {
      name: 'simulate_event',
      description: 'Pretend an event happened (to test workflows), e.g. {"source":"plex","type":"media.pause","player":"Living Room TV","mediaType":"movie"}.',
      inputSchema: { type: 'object', properties: { event: { type: 'object' } }, required: ['event'], additionalProperties: false },
      run: async (a) => {
        engine.handle({ ...a.event, simulated: true, at: new Date().toISOString() });
        return { ok: true };
      },
    },
  ];
  return tools;
}

export async function callTool(tools, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return tool.run(args ?? {});
}
