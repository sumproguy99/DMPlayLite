// Playlite UI — plain JS, no build step.

// ---------- vocab ----------
const SOURCES = [
  { id: 'plex', icon: '🎬', name: 'Plex', blurb: 'Playback & players' },
  { id: 'network', icon: '📶', name: 'Network device', blurb: 'Phones, TVs, anything on Wi-Fi' },
  { id: 'homeassistant', icon: '🏠', name: 'Home Assistant', blurb: 'Any sensor, switch, lock…' },
  { id: 'hue', icon: '🔘', name: 'Hue sensor', blurb: 'Motion, dimmers, buttons, contact' },
  { id: 'time', icon: '🌅', name: 'Time & sun', blurb: 'Clock, sunrise, sunset' },
  { id: 'webhook', icon: '🔗', name: 'Webhook / Siri', blurb: 'Shortcuts, IFTTT, Zapier, anything' },
  { id: 'mode', icon: '🎭', name: 'House mode', blurb: 'Home, away, movie, sleep…' },
  { id: 'mqtt', icon: '📡', name: 'MQTT', blurb: 'Zigbee2MQTT, Tasmota, sensors…' },
];
const EVENTS = {
  plex: [
    ['player.online', 'Plex app opens on a device'],
    ['media.play', 'Video starts playing'],
    ['media.pause', 'Paused'],
    ['media.resume', 'Play pressed (resume)'],
    ['media.stop', 'Stopped'],
    ['media.scrobble', 'Marked watched (~90%)'],
    ['player.offline', 'Plex app closes'],
  ],
  network: [
    ['device.online', 'A device joins the network (comes home)'],
    ['device.offline', 'A device leaves the network'],
    ['device.new', 'A never-seen-before device joins'],
  ],
  homeassistant: [['state', 'An entity changes state']],
  hue: [['motion', 'Motion sensor'], ['button', 'Button / dimmer pressed'], ['contact', 'Door / window contact']],
  time: [
    ['time.at', 'At a time of day'],
    ['sun.sunset', 'At sunset'],
    ['sun.sunrise', 'At sunrise'],
  ],
  webhook: [],
  mode: [['mode.changed', 'House mode changes']],
  mqtt: [['message', 'A message arrives']],
};
const MEDIA_TYPES = [['movie', 'Movies'], ['episode', 'TV episodes'], ['clip', 'Clips'], ['track', 'Music']];
const WHITES = [[2200, 'Candle'], [2700, 'Warm'], [3000, 'Soft'], [4000, 'Natural'], [5000, 'Daylight'], [6500, 'Cool']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEP_TYPES = [
  ['set', '💡', 'Set / fade lights'],
  ['pulse', '✨', 'Pulse lights'],
  ['wait', '⏱', 'Wait'],
  ['http', '🌐', 'Call a URL'],
  ['ha', '🏠', 'Home Assistant action'],
  ['notify', '📲', 'Phone alert'],
  ['mode', '🎭', 'Set house mode'],
  ['scene', '🎬', 'Scene'],
  ['capture', '📸', 'Save scene'],
  ['mqtt', '📡', 'MQTT message'],
  ['plex', '▶️', 'Plex playback'],
  ['roku', '📺', 'Roku remote'],
];
const modeOptions = (selected, anyLabel) => `${anyLabel ? `<option value="">${anyLabel}</option>` : ''}${S.state.modes.map((m) => `<option value="${esc(m)}" ${selected === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}`;
const HUE_PRESSES = [['short_release', 'Short press'], ['long_press', 'Long press (hold)'], ['repeat', 'Held — repeats while held'], ['long_release', 'Released after holding'], ['initial_press', 'Pressed down (fastest)']];
const PLEX_ACTIONS = [['pause', 'Pause'], ['play', 'Play / resume'], ['toggle', 'Pause or resume'], ['stop', 'Stop'], ['next', 'Next'], ['previous', 'Previous'], ['forward', 'Skip forward ~30 s'], ['back', 'Skip back ~10 s']];
const ROKU_KEYS = [['Play', 'Play / pause'], ['Home', 'Home'], ['Back', 'Back'], ['Select', 'OK'], ['Rev', 'Rewind'], ['Fwd', 'Fast-forward'], ['InstantReplay', 'Instant replay'], ['VolumeUp', 'Volume up'], ['VolumeDown', 'Volume down'], ['VolumeMute', 'Mute'], ['PowerOff', 'Power off (Roku TV)'], ['PowerOn', 'Power on (Roku TV)']];
const ROKU_APPS = ['plex', 'netflix', 'youtube', 'disney+', 'hulu', 'prime video', 'max', 'spotify'];
const NTFY_PRIORITIES = [[1, 'Min'], [2, 'Low'], [3, 'Normal'], [4, 'High'], [5, 'Urgent']];
const KIND_ICON = {
  phone: '📱', tablet: '📱', apple: '🍎', computer: '💻', printer: '🖨', router: '🛜', camera: '📷', doorbell: '🔔',
  thermostat: '🌡', echo: '🗣', google: '🗣', chromecast: '📺', 'android-tv': '📺', 'fire-tv': '📺', tv: '📺', roku: '📺',
  airplay: '📺', sonos: '🔊', speaker: '🔊', 'hue-bridge': '💡', wled: '💡', govee: '💡', nanoleaf: '💡', elgato: '💡',
  'home-assistant': '🏠', esphome: '🔌', shelly: '🔌', iot: '🔌', matter: '🔌', homekit: '🔌', 'plex-server': '🎬',
  'media-server': '🗄', console: '🎮', garage: '🚗', unknown: '❔',
};

const S = { state: null, lights: [], groups: [], network: [], netFilter: '', netOnline: true };

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (o) => structuredClone(o);
const eventLabel = (src, ev) => EVENTS[src]?.find(([k]) => k === ev)?.[1] ?? ev;
const sec = (ms) => +((ms ?? 0) / 1000).toFixed(2);
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 6000 : 2500);
}
const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};
const busy = async (btn, label, fn) => {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
};

function targetName(id) {
  if (id.startsWith('group:')) return S.groups.find((g) => `group:${g.id}` === id)?.name ?? id;
  return S.lights.find((l) => l.id === id)?.name ?? id;
}

function copyBox(text) {
  return `<div class="copy"><code>${esc(text)}</code><button class="btn sm" data-copy="${esc(text)}">Copy</button></div>`;
}
function wireCopy(el) {
  el.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied'))));
}

// ---------- load ----------
async function refresh() {
  S.state = await api('GET', '/api/state');
  S.groups = S.state.groups;
  renderHeader();
  renderRoutines();
  renderConnections();
  renderActivity();
}
async function refreshLights() {
  const { lights, groups } = await api('GET', '/api/lights');
  S.lights = lights;
  S.groups = groups;
  renderLights();
  renderRoutines();
}
async function refreshNetwork() {
  const { devices } = await api('GET', '/api/network');
  S.network = devices;
  renderNetwork();
}

// ---------- header ----------
function renderHeader() {
  if (document.activeElement?.id === 'mode-pick') return; // don't close the mode menu while it's open
  const st = S.state;
  const p = st.plex;
  const pill = (dot, text) => `<span class="pill"><span class="dot ${dot}"></span>${text}</span>`;
  const plex = !p.hasToken ? pill('', 'Plex') : p.status.connected ? pill(p.status.socket === 'live' ? 'ok' : 'warn', 'Plex') : pill('bad', 'Plex');
  const haS = st.homeassistant;
  $('#pills').innerHTML = [
    pill(st.network.status.running ? 'ok' : '', `${st.network.online} on network`),
    plex,
    pill(st.hue.paired ? 'ok' : '', 'Hue'),
    pill(st.govee.devices.length ? 'ok' : '', `Govee ${st.govee.devices.length || ''}`),
    pill(!haS.hasToken ? '' : haS.status.connected ? 'ok' : 'bad', 'Home Assistant'),
    pill(st.alexa.status.http === 'listening' ? 'ok' : st.alexa.enabled ? 'bad' : '', 'Alexa'),
    pill(st.ai.ready ? 'ok' : '', 'AI'),
    `<label class="pill mode" title="House mode">🎭 <select id="mode-pick">${modeOptions(st.mode)}</select></label>`,
    `<button class="pill user" id="account-btn" title="Account">👤 ${esc(st.user)}</button>`,
  ].join('');
  $('#account-btn').onclick = openAccount;
  $('#mode-pick').onchange = guard(async (e) => {
    const { mode } = await api('POST', '/api/mode', { mode: e.target.value });
    S.state.mode = mode;
    toast(`House mode: ${mode}`);
  });
}

// ---------- routines ----------
function describeStep(step) {
  const t = step.targets?.length ? ` · ${step.targets.map(targetName).map(esc).join(', ')}` : '';
  if (step.type === 'wait') return `⏱ wait ${sec(step.ms)}s`;
  if (step.type === 'http') return `🌐 ${esc(step.method ?? 'POST')} ${esc(step.url)}`;
  if (step.type === 'ha') return `🏠 ${esc(step.service)} ${esc(step.data?.entity_id ?? '')}`;
  if (step.type === 'mode') return `🎭 house mode → <b>${esc(step.mode)}</b>`;
  if (step.type === 'mqtt') return `📡 ${esc(step.topic)} ← ${esc(typeof step.payload === 'object' ? JSON.stringify(step.payload) : step.payload ?? '')}${step.retain ? ' (retained)' : ''}`;
  if (step.type === 'plex') return `▶️ Plex <b>${esc(PLEX_ACTIONS.find(([k]) => k === step.action)?.[1].toLowerCase() ?? step.action)}</b> on ${step.player ? esc(step.player) : 'the player that triggered it / is playing'}`;
  if (step.type === 'roku') return `📺 Roku${step.device ? ` ${esc(step.device)}` : ''}: ${step.app ? `open <b>${esc(step.app)}</b>` : `<b>${esc(ROKU_KEYS.find(([k]) => k === step.key)?.[1] ?? step.key)}</b>`}`;
  if (step.type === 'scene') return `🎬 scene <b>${esc(step.scene)}</b>${step.transitionMs ? ` over ${sec(step.transitionMs)}s` : ''}`;
  if (step.type === 'capture') return `📸 save lights as scene <b>${esc(step.scene)}</b>${t}`;
  if (step.type === 'notify') return `📲 “${esc(step.title ? `${step.title}: ${step.message}` : step.message)}”${step.topic ? ` → ${esc(step.topic)}` : ''}${step.priority >= 4 ? ' (high priority)' : ''}`;
  if (step.type === 'pulse') return `✨ pulse ${step.levels.join('→')}% ×${step.times} (${sec(step.stepMs)}s/step)${step.restore ? ', then restore' : ''}${t}`;
  const parts = [];
  if (step.on === false || step.brightness === 0) parts.push('off');
  else if (step.brightness != null) parts.push(`${step.brightness}%`);
  if (step.kelvin) parts.push(`${WHITES.find(([k]) => k === step.kelvin)?.[1] ?? ''} ${step.kelvin}K`.trim());
  if (step.color) parts.push(`<span class="swatch" style="background:${esc(step.color)}"></span>${esc(step.color)}`);
  return `💡 ${step.transitionMs ? 'fade to' : 'set'} ${parts.join(' · ') || 'on'}${step.transitionMs ? ` over ${sec(step.transitionMs)}s` : ''}${t}`;
}

function describeTrigger(tr) {
  const src = SOURCES.find((s) => s.id === tr.source);
  const b = (s) => `<b>${esc(s)}</b>`;
  let text;
  if (tr.source === 'webhook') text = `webhook ${b(tr.event)} is called`;
  else if (tr.source === 'time' && tr.event === 'time.at') text = `it's ${b(tr.at)}${tr.days?.length && tr.days.length < 7 ? ` on ${tr.days.map((d) => DAYS[d]).join(', ')}` : ''}`;
  else if (tr.source === 'time') text = `${b(tr.event === 'sun.sunset' ? 'sunset' : 'sunrise')}${tr.offsetMin ? ` ${tr.offsetMin > 0 ? '+' : '−'}${Math.abs(tr.offsetMin)} min` : ''}`;
  else if (tr.source === 'hue') text = `${b(tr.device || 'any Hue sensor')} ${tr.event === 'button' ? `${HUE_PRESSES.find(([k]) => k === (tr.press ?? 'short_release'))?.[1].toLowerCase() ?? esc(tr.press)}${tr.button ? ` on button ${b(tr.button)}` : ''}` : tr.event === 'motion' ? (tr.to === 'clear' ? 'motion clears' : tr.to === 'detected' ? 'detects motion' : 'motion changes') : tr.to ? `is ${b(tr.to)}` : 'opens or closes'}`;
  else if (tr.source === 'mqtt') text = `MQTT ${b(tr.topic || 'any topic')}${tr.field ? ` — ${b(tr.field)} changes${tr.value != null && tr.value !== '' ? ` to ${b(tr.value)}` : ''}` : tr.payload ? ` says ${b(tr.payload)}` : ''}`;
  else if (tr.source === 'mode') text = `house mode changes${tr.from ? ` from ${b(tr.from)}` : ''}${tr.to ? ` to ${b(tr.to)}` : ''}`;
  else if (tr.source === 'homeassistant') text = `${b(tr.entity || 'any entity')} changes${tr.from ? ` from ${b(tr.from)}` : ''}${tr.to ? ` to ${b(tr.to)}` : ''}`;
  else text = b(eventLabel(tr.source, tr.event));
  const bits = [text];
  if (tr.player) bits.push(`on ${b(tr.player)}`);
  if (tr.device && tr.source !== 'hue') bits.push(`— ${b(tr.device)}`);
  if (tr.user) bits.push(`by ${b(tr.user)}`);
  if (tr.mediaTypes?.length && tr.mediaTypes.length < 4) bits.push(`(${tr.mediaTypes.join(', ')})`);
  if (tr.forMin > 0) bits.push(`for ${b(`${tr.forMin} min`)}`);
  return `<span class="src-icon">${src?.icon ?? '⚡'}</span> ${bits.join(' ')}`;
}

function describeConditionGroup(c = {}) {
  const out = [];
  if (c.timeWindow) out.push(`${c.timeWindow.from}–${c.timeWindow.to}`);
  if (c.dark) out.push("it's dark");
  if (c.light) out.push("it's daytime");
  if (c.fullMoon) out.push('full moon');
  if (c.mode?.length) out.push(`mode is ${[c.mode].flat().join(' or ')}`);
  if (c.presence?.device) out.push(`${c.presence.device} is ${c.presence.state}`);
  return out.map(esc).join(' · ');
}

function describeConditions(r) {
  const groups = [r.conditions, ...(r.orConditions ?? [])].map(describeConditionGroup).filter(Boolean);
  const text = groups.join(' <span class="kw">OR</span> ');
  const cool = r.cooldownSec ? `${text ? ' · ' : ''}cooldown ${r.cooldownSec}s` : '';
  return text || cool ? `<div class="when muted">${text ? 'Only if ' : ''}${text}${cool}</div>` : '';
}

function renderRoutines() {
  const el = $('#tab-routines');
  if (!S.state) return;
  const rs = S.state.routines;
  el.innerHTML = `
    <div class="idea card">
      <div class="idea-head"><span class="idea-spark">✨</span><div><h2>Got an idea?</h2><p class="sub" style="margin:0">Type it the way you'd say it — “if the front door opens after dark, turn the hallway to 40%”.</p></div></div>
      <form class="idea-row" id="idea-form">
        <input type="text" id="idea" placeholder="If … then …" autocomplete="off">
        <button class="btn primary" id="idea-go">Build it</button>
      </form>
      ${S.state.ai.ready ? '' : '<p class="small muted" style="margin:6px 0 0">AI building needs a Claude API key (Connections → AI). Without one, this opens the step-by-step builder.</p>'}
    </div>
    <div class="row spread" style="margin:22px 0 12px">
      <div><h2>Workflows</h2><p class="sub" style="margin:0">IF this happens → THEN do that.</p></div>
      <button class="btn primary" id="new-routine">+ New workflow</button>
    </div>
    <div class="stack">
      ${rs.length ? '' : '<div class="card empty">No workflows yet.</div>'}
      ${rs.map((r, i) => `
        <div class="card wf ${r.enabled ? '' : 'off'}">
          <div class="row spread">
            <div class="row" style="gap:12px;flex:1;min-width:0">
              <label class="switch" title="On/off"><input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''}><span></span></label>
              <h3>${esc(r.name)}</h3>
              ${r.voiceName ? `<span class="chip" title="Alexa / Siri name">🗣 “${esc(r.voiceName)}”</span>` : ''}
              ${(S.state.waiting ?? []).filter((w) => w.name === r.name).map((w) => `<span class="chip" title="Runs if it stays that way">⏳ waiting ${w.forMin} min${w.subject ? ` · ${esc(w.subject)}` : ''}</span>`).join('')}
            </div>
            <div class="row">
              <button class="btn sm" data-run="${esc(r.id)}">Run now</button>
              <button class="btn sm" data-edit="${i}">Edit</button>
            </div>
          </div>
          <div class="ifthen">
            <div><span class="kw">IF</span> ${[r.trigger, ...(r.orTriggers ?? [])].map(describeTrigger).join(' <span class="kw">OR</span> ')}</div>
            ${describeConditions(r)}
            <div><span class="kw then">THEN</span>
              <ol class="steps-list">${r.steps.map((s) => `<li>${describeStep(s)}</li>`).join('')}</ol>
            </div>
          </div>
          ${r.steps.some((s) => s.type === 'set' || s.type === 'pulse') ? `<div class="chips">${(r.targets ?? []).map((t) => `<span class="chip">💡 ${esc(targetName(t))}</span>`).join('') || '<span class="chip">⚠ no lights selected</span>'}</div>` : ''}
        </div>`).join('')}
    </div>`;
  $('#new-routine').onclick = () => openEditor(null);
  $('#idea-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    const text = $('#idea').value.trim();
    if (!text) return;
    if (!S.state.ai.ready) return openEditor(null, null, text);
    await busy($('#idea-go'), 'Thinking…', async () => {
      const { workflow, summary } = await api('POST', '/api/ai/draft', { text });
      openEditor(null, workflow, summary);
    });
  });
  el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEditor(+b.dataset.edit)));
  el.querySelectorAll('[data-run]').forEach((b) => (b.onclick = guard(async () => {
    await api('POST', '/api/routines/run', { id: b.dataset.run });
    toast('Running…');
  })));
  el.querySelectorAll('[data-toggle]').forEach((c) => (c.onchange = guard(async () => {
    const routines = clone(S.state.routines);
    routines[+c.dataset.toggle].enabled = c.checked;
    await saveRoutines(routines);
  })));
}

async function saveRoutines(routines) {
  const res = await api('PUT', '/api/routines', routines);
  S.state.routines = res.routines;
  renderRoutines();
}

// ---------- IF / THEN builder ----------
let draft = null;
let draftIndex = null;
let draftNote = null;

function openEditor(index, prefilled = null, note = null) {
  draftIndex = index;
  draftNote = note;
  draft = prefilled ? clone(prefilled)
    : index == null ? { name: '', enabled: true, trigger: { source: 'plex', event: 'media.play', player: '', mediaTypes: ['movie', 'episode', 'clip'] }, targets: [], steps: [{ type: 'set', brightness: 10, transitionMs: 5000 }] }
    : clone(S.state.routines[index]);
  renderEditor();
  $('#editor').showModal();
}

function targetPicker(selected, path) {
  const options = [
    ...S.groups.map((g) => ({ id: `group:${g.id}`, name: g.name, note: `group · ${g.members.length} light${g.members.length === 1 ? '' : 's'}` })),
    ...S.lights.map((l) => ({ id: l.id, name: l.name, note: l.kind.replace('-', ' ') })),
  ];
  if (!options.length) return '<p class="muted small">No lights yet — connect Hue, Govee or Home Assistant under Connections.</p>';
  return `<div class="checks">${options.map((o) => `
    <label class="check"><input type="checkbox" data-list="${path}" value="${esc(o.id)}" ${selected?.includes(o.id) ? 'checked' : ''}>
    <span>${esc(o.name)}<br><small>${esc(o.note)}</small></span></label>`).join('')}</div>`;
}

// Same rule as the engine: only triggers describing a state that can end can "stay that way".
const canHold = (tr) => ['plex', 'network', 'homeassistant', 'mode', 'mqtt', 'hue'].includes(tr.source) && !['device.new', 'media.scrobble', 'button'].includes(tr.event);

function triggerFields(tr, base = 'trigger') {
  if (!canHold(tr)) {
    delete tr.forMin;
    return sourceFields(tr, base);
  }
  return `${sourceFields(tr, base)}
      <div class="fields" style="margin-top:10px">
        <label class="field">…and it stays that way for <small>(minutes, optional)</small><input type="number" min="0" step="any" data-bind="${base}.forMin" data-type="num" value="${tr.forMin ?? ''}" placeholder="no wait"></label>
      </div>`;
}

function sourceFields(tr, base) {
  const ev = EVENTS[tr.source] ?? [];
  const eventSelect = ev.length
    ? `<label class="field grow">What happens<select data-bind="${base}.event" data-rerender>${ev.map(([k, n]) => `<option value="${k}" ${tr.event === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
    : '';
  if (tr.source === 'plex') {
    const players = S.state.plex.status.players ?? [];
    return `<div class="fields">${eventSelect}
        <label class="field grow">On player (name contains)<input type="text" data-bind="${base}.player" value="${esc(tr.player)}" placeholder="any device" list="players"></label>
        <datalist id="players">${players.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></div>
      ${tr.event.startsWith('media.') ? `<div class="row small" style="margin-top:10px">${MEDIA_TYPES.map(([k, n]) => `<label class="row"><input type="checkbox" data-list="${base}.mediaTypes" value="${k}" ${tr.mediaTypes?.includes(k) ? 'checked' : ''}> ${n}</label>`).join('')}</div>` : ''}
      <div class="fields" style="margin-top:10px">
        <label class="field">Plex user contains<input type="text" data-bind="${base}.user" value="${esc(tr.user)}" placeholder="anyone"></label>
        ${tr.event === 'media.play' ? `<label class="row small"><input type="checkbox" data-bind="${base}.skipContinued" data-type="bool" ${tr.skipContinued ? 'checked' : ''}> Ignore autoplay of the next episode</label>` : ''}
      </div>`;
  }
  if (tr.source === 'network') {
    const names = [...new Set(S.network.map((d) => d.name).filter(Boolean))];
    return `<div class="fields">${eventSelect}
      <label class="field grow">Which device (name, IP or type contains)<input type="text" data-bind="${base}.device" value="${esc(tr.device)}" placeholder="${tr.event === 'device.new' ? 'any new device' : 'e.g. iPhone'}" list="netdevs"></label>
      <datalist id="netdevs">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <p class="small muted">Phones nap on Wi-Fi, so “leaves” fires about 10 min after a device stops answering. Add a cooldown to avoid repeats.</p>`;
  }
  if (tr.source === 'homeassistant') {
    return `<div class="fields">
      <label class="field grow">Entity (id or name contains)<input type="text" data-bind="${base}.entity" value="${esc(tr.entity)}" placeholder="binary_sensor.front_door" list="haents"></label>
      <datalist id="haents" data-ha-list></datalist>
      <label class="field">From<input type="text" data-bind="${base}.from" value="${esc(tr.from)}" placeholder="any"></label>
      <label class="field">To<input type="text" data-bind="${base}.to" value="${esc(tr.to)}" placeholder="e.g. on"></label></div>
      ${S.state.homeassistant.status.connected ? '' : '<p class="small muted">Connect Home Assistant under Connections first.</p>'}`;
  }
  if (tr.source === 'hue') {
    const sensors = S.state.hue.sensors?.devices ?? [];
    const kind = tr.event;
    // keep only the filters that make sense for this kind of sensor
    if (kind === 'button') {
      delete tr.to;
      tr.press ??= 'short_release'; // otherwise one press fires twice (pressed + released)
    } else {
      delete tr.button;
      delete tr.press;
      const valid = kind === 'motion' ? ['detected', 'clear'] : ['open', 'closed'];
      if (tr.to && !valid.includes(tr.to)) tr.to = valid[0];
    }
    const names = sensors.filter((x) => x.kinds.includes(kind)).map((x) => x.name);
    const opt = (v, label, cur) => `<option value="${v}" ${(cur ?? '') === v ? 'selected' : ''}>${label}</option>`;
    return `<div class="fields">${eventSelect}
      <label class="field grow">Which ${kind === 'button' ? 'button / dimmer' : 'sensor'} (name contains)<input type="text" data-bind="${base}.device" value="${esc(tr.device)}" placeholder="any" list="huesensors-${kind}"></label>
      <datalist id="huesensors-${kind}">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${kind === 'motion' ? `<label class="field">When<select data-bind="${base}.to">${opt('detected', 'Motion detected', tr.to)}${opt('clear', 'Motion clears', tr.to)}${opt('', 'Either', tr.to)}</select></label>` : ''}
      ${kind === 'contact' ? `<label class="field">When<select data-bind="${base}.to">${opt('open', 'Opens', tr.to)}${opt('closed', 'Closes', tr.to)}${opt('', 'Either', tr.to)}</select></label>` : ''}
      ${kind === 'button' ? `<label class="field">Button<select data-bind="${base}.button" data-type="num">${opt('', 'Any', tr.button == null ? '' : String(tr.button))}${[1, 2, 3, 4].map((n) => opt(String(n), `${n}${n === 1 ? ' (top / On)' : n === 4 ? ' (bottom / Off)' : ''}`, tr.button == null ? '' : String(tr.button))).join('')}</select></label>
        <label class="field">Press<select data-bind="${base}.press">${HUE_PRESSES.map(([k, n]) => opt(k, n, tr.press ?? 'short_release')).join('')}</select></label>` : ''}
      </div>
      ${S.state.hue.sensors?.connected ? (names.length ? '' : `<p class="small muted">No Hue ${kind === 'button' ? 'buttons or dimmers' : `${kind} sensors`} found on the bridge yet.</p>`) : `<p class="small muted">${S.state.hue.paired ? `Hue sensors aren't connected${S.state.hue.sensors?.lastError ? ` (${esc(S.state.hue.sensors.lastError)})` : ''}.` : 'Pair the Hue bridge under Connections first.'}</p>`}`;
  }
  if (tr.source === 'mqtt') {
    const last = S.mqttTopics?.find((x) => x.topic === tr.topic);
    return `<div class="fields">
      <label class="field grow">Topic <small>(+ and # wildcards ok)</small><input type="text" data-bind="${base}.topic" value="${esc(tr.topic)}" placeholder="zigbee2mqtt/Hall motion" list="mqtttopics" data-rerender-blur></label>
      <label class="field">JSON field <small>(optional)</small><input type="text" data-bind="${base}.field" value="${esc(tr.field)}" placeholder="e.g. occupancy" data-rerender-blur></label>
      ${tr.field
        ? `<label class="field">Changes to <small>(optional)</small><input type="text" data-bind="${base}.value" value="${esc(tr.value)}" placeholder="any change"></label>`
        : `<label class="field">Message equals <small>(optional)</small><input type="text" data-bind="${base}.payload" value="${esc(tr.payload)}" placeholder="any message"></label>`}
      </div>
      <datalist id="mqtttopics" data-mqtt-list></datalist>
      ${last ? `<p class="small muted" style="margin:6px 0 0">Last message: <code>${esc(last.payload.slice(0, 200))}</code></p>` : ''}
      <p class="small muted" style="margin:6px 0 0">${tr.field ? 'Fires when that field changes — not on every repeat of the same value.' : 'Leave the JSON field empty to match the whole message (Tasmota “ON”, rtl_433 lines…).'} Use {{topic}}, {{payload}}, {{json.<i>field</i>}} in later steps.</p>
      ${S.state.mqtt?.status.connected ? '' : '<p class="small muted">Connect MQTT under Connections first.</p>'}`;
  }
  if (tr.source === 'mode') {
    return `<div class="fields">
      <label class="field grow">From<select data-bind="${base}.from">${modeOptions(tr.from, 'any mode')}</select></label>
      <label class="field grow">To<select data-bind="${base}.to">${modeOptions(tr.to, 'any mode')}</select></label></div>
      <p class="small muted">Switch modes from the menu at the top, a “🎭 Set house mode” step, Siri (Connections → Siri) or the AI.</p>`;
  }
  if (tr.source === 'time') {
    const sunNote = S.state.location?.lat ? '' : '<p class="small" style="color:var(--warn)">Set your location under Connections → Location for sunrise/sunset.</p>';
    return `<div class="fields">${eventSelect}
      ${tr.event === 'time.at'
        ? `<label class="field">Time<input type="time" data-bind="${base}.at" value="${esc(tr.at ?? '18:00')}"></label>`
        : `<label class="field">Offset (minutes, − = before)<input type="number" data-bind="${base}.offsetMin" data-type="num" value="${tr.offsetMin ?? 0}"></label>`}
      </div>
      <div class="row small" style="margin-top:10px">${DAYS.map((d, i) => `<label class="daychip"><input type="checkbox" data-list="${base}.days" data-num value="${i}" ${!tr.days?.length || tr.days.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      ${tr.event === 'time.at' ? '' : sunNote}`;
  }
  // webhook
  const url = S.state.urls.hook.replace('<name>', encodeURIComponent(tr.event || 'name'));
  return `<div class="fields"><label class="field grow">Webhook name<input type="text" data-bind="${base}.event" value="${esc(tr.event)}" placeholder="e.g. doorbell" data-rerender-blur></label></div>
    <p class="small muted" style="margin-bottom:4px">Call this URL (GET or POST) from Siri Shortcuts, IFTTT, Zapier, Home Assistant, a Stream Deck…</p>${copyBox(url)}`;
}

function stepEditor(step, i) {
  const p = `steps.${i}`;
  let body = '';
  if (step.type === 'set') {
    const mode = step.kelvin ? 'kelvin' : step.color ? 'color' : 'none';
    body = `
      <div class="fields">
        <label class="field">Brightness %<input type="number" min="0" max="100" data-bind="${p}.brightness" data-type="num" value="${step.brightness ?? ''}" placeholder="same"></label>
        <label class="field">Color
          <select data-mode="${i}">
            <option value="none" ${mode === 'none' ? 'selected' : ''}>Keep current</option>
            <option value="kelvin" ${mode === 'kelvin' ? 'selected' : ''}>White temperature</option>
            <option value="color" ${mode === 'color' ? 'selected' : ''}>Color</option>
          </select></label>
        ${mode === 'kelvin' ? `<label class="field">White
          <select data-bind="${p}.kelvin" data-type="num">${WHITES.map(([k, n]) => `<option value="${k}" ${step.kelvin === k ? 'selected' : ''}>${n} (${k}K)</option>`).join('')}
          ${WHITES.some(([k]) => k === step.kelvin) ? '' : `<option value="${step.kelvin}" selected>${step.kelvin}K</option>`}</select></label>` : ''}
        ${mode === 'color' ? `<label class="field">Pick<input type="color" data-bind="${p}.color" value="${esc(step.color)}"></label>` : ''}
        <label class="field">Fade (seconds)<input type="number" min="0" step="0.5" data-bind="${p}.transitionMs" data-type="sec" value="${sec(step.transitionMs)}"></label>
      </div>
      <p class="muted small" style="margin:0">Brightness 0 turns lights off. Blank keeps the current brightness.</p>`;
  } else if (step.type === 'pulse') {
    body = `
      <div class="fields">
        <label class="field grow">Brightness pattern (%)<input type="text" data-bind="${p}.levels" data-type="levels" value="${esc(step.levels.join(', '))}"></label>
        <label class="field">Repeat<input type="number" min="1" max="50" data-bind="${p}.times" data-type="num" value="${step.times}"></label>
        <label class="field">Seconds per change<input type="number" min="0.2" step="0.1" data-bind="${p}.stepMs" data-type="sec" value="${sec(step.stepMs)}"></label>
      </div>
      <label class="row small"><input type="checkbox" data-bind="${p}.restore" data-type="bool" ${step.restore ? 'checked' : ''}> Put lights back how they were afterwards</label>`;
  } else if (step.type === 'wait') {
    body = `<div class="fields"><label class="field">Wait (seconds)<input type="number" min="0" step="0.5" data-bind="${p}.ms" data-type="sec" value="${sec(step.ms)}"></label></div>`;
  } else if (step.type === 'http') {
    body = `<div class="fields">
        <label class="field">Method<select data-bind="${p}.method">${['POST', 'GET', 'PUT'].map((m) => `<option ${step.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="field grow">URL<input type="text" data-bind="${p}.url" value="${esc(step.url)}" placeholder="https://ntfy.sh/my-topic"></label>
      </div>
      <label class="field">Body (JSON or text)<textarea data-bind="${p}.body" data-type="jsonish" rows="3" placeholder='{"message":"{{player}} started {{title}}"}'>${esc(typeof step.body === 'object' ? JSON.stringify(step.body, null, 1) : step.body ?? '')}</textarea></label>
      <p class="muted small" style="margin:0">Use {{player}}, {{title}}, {{device}}, {{entity}}, {{to}} to insert details from the trigger. Works with ntfy, IFTTT Maker, Zapier, Discord/Slack webhooks, Home Assistant webhooks…</p>`;
  } else if (step.type === 'ha') {
    body = `<div class="fields">
        <label class="field grow">Service<input type="text" data-bind="${p}.service" value="${esc(step.service)}" placeholder="switch.turn_on" list="hasvc"></label>
        <datalist id="hasvc">${['light.turn_on', 'light.turn_off', 'switch.turn_on', 'switch.turn_off', 'scene.turn_on', 'script.turn_on', 'climate.set_temperature', 'media_player.media_pause', 'media_player.media_play', 'lock.lock', 'cover.close_cover', 'notify.notify', 'tts.speak'].map((s) => `<option value="${s}">`).join('')}</datalist>
        <label class="field grow">Entity<input type="text" data-bind="${p}.data.entity_id" value="${esc(step.data?.entity_id)}" placeholder="switch.fan" list="haents"></label>
      </div>`;
  } else if (step.type === 'mode') {
    body = `<div class="fields"><label class="field grow">Switch the house mode to<select data-bind="${p}.mode">${modeOptions(step.mode)}</select></label></div>`;
  } else if (step.type === 'mqtt') {
    body = `<div class="fields">
        <label class="field grow">Topic<input type="text" data-bind="${p}.topic" value="${esc(step.topic)}" placeholder="zigbee2mqtt/Lamp/set" list="mqtttopics"></label>
        <label class="row small"><input type="checkbox" data-bind="${p}.retain" data-type="flag" ${step.retain ? 'checked' : ''}> Retain</label>
      </div>
      <label class="field">Message (JSON or text)<textarea data-bind="${p}.payload" data-type="jsonish" rows="2" placeholder='{"state":"ON","brightness":200}'>${esc(typeof step.payload === 'object' ? JSON.stringify(step.payload) : step.payload ?? '')}</textarea></label>
      <p class="muted small" style="margin:0">Zigbee2MQTT: <code>zigbee2mqtt/&lt;name&gt;/set</code> with <code>{"state":"TOGGLE"}</code> · Tasmota: <code>cmnd/&lt;name&gt;/POWER</code> with <code>ON</code>. {{variables}} work.</p>`;
  } else if (step.type === 'plex') {
    const players = S.state.plex.status.players ?? [];
    body = `<div class="fields">
        <label class="field">Do<select data-bind="${p}.action">${PLEX_ACTIONS.map(([k, n]) => `<option value="${k}" ${step.action === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field grow">On player (name contains)<input type="text" data-bind="${p}.player" value="${esc(step.player)}" placeholder="the one that triggered it / is playing" list="plexplayers"></label>
        <datalist id="plexplayers">${players.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </div>
      <p class="muted small" style="margin:0">E.g. doorbell → pause the movie. Works with players that allow remote control (Plex HTPC, Plex for Android TV / Fire TV / Apple TV / Roku, Plexamp…); some newer phone and desktop apps don't.${S.state.plex.status.connected ? '' : ' <span style="color:var(--warn)">Connect Plex under Connections first.</span>'}</p>`;
  } else if (step.type === 'roku') {
    const rokus = S.state.rokus ?? [];
    const mode = step.app ? 'app' : 'key';
    body = `<div class="fields">
        <label class="field grow">Roku (name or IP)<input type="text" data-bind="${p}.device" value="${esc(step.device)}" placeholder="${rokus.length === 1 ? esc(rokus[0].name) : 'e.g. Living Room Roku'}" list="rokus"></label>
        <datalist id="rokus">${rokus.map((r) => `<option value="${esc(r.name)}">`).join('')}</datalist>
        <label class="field">Do<select data-rokumode="${i}"><option value="key" ${mode === 'key' ? 'selected' : ''}>Press a button</option><option value="app" ${mode === 'app' ? 'selected' : ''}>Open an app</option></select></label>
        ${mode === 'key'
          ? `<label class="field">Button<select data-bind="${p}.key">${ROKU_KEYS.map(([k, n]) => `<option value="${k}" ${step.key === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
          : `<label class="field">App<input type="text" data-bind="${p}.app" value="${esc(step.app)}" list="rokuapps"></label><datalist id="rokuapps">${ROKU_APPS.map((a) => `<option value="${a}">`).join('')}</datalist>`}
      </div>
      <p class="muted small" style="margin:0">${rokus.length ? `Found: ${rokus.map((r) => esc(r.name)).join(', ')}. ` : 'No Roku found on the network yet. '}If it refuses, on the Roku turn on Settings → System → Advanced system settings → <b>Control by mobile apps</b>.</p>`;
  } else if (step.type === 'scene') {
    body = `<div class="fields">
        <label class="field grow">Scene<input type="text" data-bind="${p}.scene" value="${esc(step.scene)}" placeholder="scene name" list="scenenames"></label>
        <label class="field">Fade (seconds)<input type="number" min="0" step="0.5" data-bind="${p}.transitionMs" data-type="sec" value="${sec(step.transitionMs)}"></label>
      </div>
      <p class="muted small" style="margin:0">Puts the lights back exactly as the scene saved them. Save scenes on the Lights tab or with a “📸 Save scene” step.</p>`;
  } else if (step.type === 'capture') {
    body = `<div class="fields"><label class="field grow">Save the lights as scene<input type="text" data-bind="${p}.scene" value="${esc(step.scene)}" placeholder="e.g. Before movie" list="scenenames"></label></div>
      <p class="muted small" style="margin:0">Remembers how the lights look right now (replacing a scene with the same name). Put it first, then restore it later with a “🎬 Scene” step — e.g. when the movie stops.</p>`;
  } else if (step.type === 'notify') {
    const topicSet = Boolean(S.state.ntfy?.topic);
    body = `<div class="fields">
        <label class="field grow">Title<input type="text" data-bind="${p}.title" value="${esc(step.title)}" placeholder="optional"></label>
        <label class="field">Priority<select data-bind="${p}.priority" data-type="num">${NTFY_PRIORITIES.map(([v, n]) => `<option value="${v}" ${(step.priority ?? 3) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <label class="field">Message<textarea data-bind="${p}.message" rows="2" placeholder="{{player}} started {{title}}">${esc(step.message)}</textarea></label>
      <details><summary class="small muted">More options</summary>
        <div class="fields" style="margin-top:8px">
          <label class="field">Topic<input type="text" data-bind="${p}.topic" value="${esc(step.topic)}" placeholder="${esc(S.state.ntfy?.topic || 'default')}"></label>
          <label class="field grow">Tags / emoji<input type="text" data-bind="${p}.tags" value="${esc(Array.isArray(step.tags) ? step.tags.join(', ') : step.tags)}" placeholder="movie_camera, warning"></label>
          <label class="field grow">Open link when tapped<input type="text" data-bind="${p}.click" value="${esc(step.click)}" placeholder="https://…"></label>
        </div></details>
      <p class="muted small" style="margin:0">Use {{player}}, {{title}}, {{device}}, {{entity}}, {{to}} to insert details from the trigger.${topicSet ? '' : ' <span style="color:var(--warn)">Set up Phone alerts under Connections first.</span>'}</p>`;
  }
  const custom = ['set', 'pulse', 'capture'].includes(step.type) && step.targets?.length;
  return `
    <div class="step">
      <div class="row spread">
        <div class="row"><span class="step-num">${i + 1}</span>
          <select data-steptype="${i}">${STEP_TYPES.map(([k, ic, n]) => `<option value="${k}" ${step.type === k ? 'selected' : ''}>${ic} ${n}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="btn sm ghost" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn sm ghost" data-move="${i}:1" ${i === draft.steps.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="btn sm ghost danger" data-delstep="${i}" title="Remove step">✕</button>
        </div>
      </div>
      ${body}
      ${['set', 'pulse', 'capture'].includes(step.type) ? `
        <label class="row small"><input type="checkbox" data-customtargets="${i}" ${custom ? 'checked' : ''}> Use different lights for this step</label>
        ${custom ? targetPicker(step.targets, `${p}.targets`) : ''}` : ''}
    </div>`;
}

// One AND-group of conditions; base is "conditions" or "orConditions.<i>".
function conditionFields(c = {}, base) {
  return `
        <div class="fields">
          <label class="row small"><input type="checkbox" data-tw="${base}" ${c.timeWindow ? 'checked' : ''}> Between</label>
          <input type="time" data-bind="${base}.timeWindow.from" value="${esc(c.timeWindow?.from ?? '17:00')}" ${c.timeWindow ? '' : 'disabled'}>
          <span class="muted">and</span>
          <input type="time" data-bind="${base}.timeWindow.to" value="${esc(c.timeWindow?.to ?? '06:00')}" ${c.timeWindow ? '' : 'disabled'}>
        </div>
        <div class="row small" style="margin-top:10px;gap:16px">
          <label class="row"><input type="checkbox" data-bind="${base}.dark" data-type="flag" ${c.dark ? 'checked' : ''}> 🌙 It's dark out</label>
          <label class="row"><input type="checkbox" data-bind="${base}.light" data-type="flag" ${c.light ? 'checked' : ''}> ☀️ It's daytime</label>
          <label class="row"><input type="checkbox" data-bind="${base}.fullMoon" data-type="flag" ${c.fullMoon ? 'checked' : ''}> 🌕 Full moon</label>
        </div>
        <div class="fields" style="margin-top:10px">
          <label class="field grow">Someone is…<input type="text" data-bind="${base}.presence.device" value="${esc(c.presence?.device)}" placeholder="device name, e.g. iPhone" list="netdevs2"></label>
          <label class="field">&nbsp;<select data-bind="${base}.presence.state">${['home', 'away'].map((s) => `<option ${c.presence?.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        </div>
        <div class="row small" style="margin-top:10px">🎭 House mode is
          ${S.state.modes.map((m) => `<label class="daychip"><input type="checkbox" data-list="${base}.mode" value="${esc(m)}" ${[c.mode].flat().includes(m) ? 'checked' : ''}><span>${esc(m)}</span></label>`).join('')}
          <span class="muted">${c.mode?.length ? '' : '(any)'}</span></div>`;
}

function renderEditor() {
  const d = draft;
  const tr = d.trigger;
  const c = d.conditions ?? {};
  const needsLights = d.steps.some((s) => ['set', 'pulse', 'capture'].includes(s.type));
  $('#editor').innerHTML = `
    <div class="dlg-head"><h2>${draftIndex == null ? 'New workflow' : 'Edit workflow'}</h2>
      <label class="row small">On <span class="switch"><input type="checkbox" data-bind="enabled" data-type="bool" ${d.enabled ? 'checked' : ''}><span></span></span></label></div>
    <div class="dlg-body">
      ${draftNote ? `<div class="note">✨ ${esc(draftNote)}</div>` : ''}
      <div class="fields">
        <label class="field grow">Name<input type="text" data-bind="name" value="${esc(d.name)}" placeholder="e.g. Movie night dim"></label>
        <label class="field">Voice name <small>(Alexa · Siri)</small><input type="text" data-bind="voiceName" value="${esc(d.voiceName)}" placeholder="e.g. Movie Mode"></label>
      </div>

      <div class="block if">
        <div class="section-label"><span class="kw">IF</span> this happens</div>
        <div class="tiles">${SOURCES.map((s) => `<button class="tile ${tr.source === s.id ? 'on' : ''}" data-source="${s.id}"><span class="tile-icon">${s.icon}</span><b>${s.name}</b><small>${s.blurb}</small></button>`).join('')}</div>
        <div style="margin-top:12px">${triggerFields(tr)}</div>
        ${(d.orTriggers ?? []).map((t, i) => `
          <div class="or-trigger">
            <div class="row spread">
              <div class="row"><span class="kw">OR</span>
                <select data-orsource="${i}">${SOURCES.map((s) => `<option value="${s.id}" ${t.source === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select>
              </div>
              <button class="btn sm ghost danger" data-delor="${i}" title="Remove this trigger">✕</button>
            </div>
            <div style="margin-top:10px">${triggerFields(t, `orTriggers.${i}`)}</div>
          </div>`).join('')}
        <button class="btn sm" id="add-or" style="margin-top:10px">+ Or when…</button>
      </div>

      <div class="block">
        <div class="section-label">Only if <small class="muted">(optional)</small></div>
        ${conditionFields(c, 'conditions')}
        ${(d.orConditions ?? []).map((g, i) => `
          <div class="or-cond">
            <div class="row spread"><div class="row"><span class="kw">OR</span> <small class="muted">only if all of these</small></div>
              <button class="btn sm ghost danger" data-delorc="${i}" title="Remove this group">✕</button></div>
            ${conditionFields(g, `orConditions.${i}`)}
          </div>`).join('')}
        <div class="row" style="margin-top:10px">
          <button class="btn sm" id="add-orc">+ Or only if…</button>
          <label class="field row small" style="margin-left:auto">Cooldown (s)<input type="number" min="0" data-bind="cooldownSec" data-type="num" value="${d.cooldownSec ?? ''}" placeholder="none" style="width:90px"></label>
        </div>
        <datalist id="netdevs2">${[...new Set(S.network.filter((x) => ['phone', 'tablet', 'apple'].includes(x.kind)).map((x) => x.name).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      </div>

      <div class="block then">
        <div class="section-label"><span class="kw then">THEN</span> do this</div>
        ${needsLights ? `<div class="small muted" style="margin-bottom:6px">Lights</div>${targetPicker(d.targets, 'targets')}<div style="height:12px"></div>` : ''}
        <div class="stack">${d.steps.map(stepEditor).join('')}</div>
        <datalist id="scenenames">${(S.state.scenes ?? []).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
        <div class="row" style="margin-top:10px">${STEP_TYPES.map(([k, ic, n]) => `<button class="btn sm" data-addstep="${k}">${ic} ${n}</button>`).join('')}</div>
      </div>
    </div>
    <div class="dlg-foot">
      <div>${draftIndex == null ? '' : '<button class="btn danger" id="del-routine">Delete</button>'}</div>
      <div class="row"><button class="btn" id="cancel-edit">Cancel</button><button class="btn" id="test-routine" title="Run the steps now without saving">Test</button><button class="btn primary" id="save-routine">Save</button></div>
    </div>`;
  wireEditor();
  if ([tr, ...(d.orTriggers ?? [])].some((t) => t.source === 'homeassistant') || d.steps.some((s) => s.type === 'ha')) fillHaEntities();
  if ([tr, ...(d.orTriggers ?? [])].some((t) => t.source === 'mqtt') || d.steps.some((s) => s.type === 'mqtt')) fillMqttTopics();
}

async function fillMqttTopics() {
  if (!S.state.mqtt?.status.connected) return;
  const fresh = !S.mqttTopics;
  S.mqttTopics = await api('GET', '/api/mqtt/topics').catch(() => S.mqttTopics ?? []);
  const html = S.mqttTopics.map((t) => `<option value="${esc(t.topic)}">`).join('');
  document.querySelectorAll('#mqtttopics').forEach((dl) => (dl.innerHTML = html));
  if (!document.getElementById('mqtttopics')) $('#editor').insertAdjacentHTML('beforeend', `<datalist id="mqtttopics">${html}</datalist>`);
  if (fresh && $('#editor').open) renderEditor(); // show "last message" hints
}

async function fillHaEntities() {
  if (!S.state.homeassistant.status.connected) return;
  S.haEntities ??= await api('GET', '/api/ha/entities').catch(() => []);
  const html = S.haEntities.map((e) => `<option value="${esc(e.entity_id)}">${esc(e.name)}</option>`).join('');
  document.querySelectorAll('#haents').forEach((dl) => (dl.innerHTML = html));
  if (!document.getElementById('haents')) $('#editor').insertAdjacentHTML('beforeend', `<datalist id="haents">${html}</datalist>`);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  const last = keys.at(-1);
  if (value === undefined) delete o[last];
  else o[last] = value;
}
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function readInput(el) {
  const v = el.type === 'checkbox' ? el.checked : el.value;
  switch (el.dataset.type) {
    case 'num': return v === '' ? undefined : Number(v);
    case 'sec': return Math.round(Number(v || 0) * 1000);
    case 'bool': return Boolean(v);
    case 'flag': return v ? true : undefined;
    case 'levels': return v.split(/[\s,→>-]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));
    case 'jsonish': {
      if (!v.trim()) return undefined;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    default: return v === '' ? undefined : v;
  }
}

function wireEditor() {
  const dlg = $('#editor');
  wireCopy(dlg);
  dlg.querySelectorAll('[data-bind]').forEach((el) => {
    const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      setPath(draft, el.dataset.bind, readInput(el));
      const pres = el.dataset.bind.match(/^(.*)\.presence\.(device|state)$/);
      if (pres) {
        const group = getPath(draft, pres[1]);
        if (!group.presence?.device) delete group.presence;
        else group.presence.state ??= 'home';
      }
      if (el.hasAttribute('data-rerender')) renderEditor();
    });
    if (el.hasAttribute('data-rerender-blur')) el.addEventListener('change', renderEditor);
  });
  const blankTrigger = (src) => {
    const t = { source: src, event: EVENTS[src][0]?.[0] ?? '' };
    if (src === 'plex') t.mediaTypes = ['movie', 'episode', 'clip'];
    if (src === 'time') t.at = '18:00';
    if (src === 'hue') t.to = 'detected';
    if (src === 'network' && !S.network.length) refreshNetwork().then(renderEditor).catch(() => {});
    return t;
  };
  dlg.querySelectorAll('[data-source]').forEach((b) => (b.onclick = () => {
    if (draft.trigger.source === b.dataset.source) return;
    draft.trigger = blankTrigger(b.dataset.source);
    renderEditor();
  }));
  dlg.querySelectorAll('[data-orsource]').forEach((el) => (el.onchange = () => {
    draft.orTriggers[+el.dataset.orsource] = blankTrigger(el.value);
    renderEditor();
  }));
  dlg.querySelectorAll('[data-delor]').forEach((el) => (el.onclick = () => {
    draft.orTriggers.splice(+el.dataset.delor, 1);
    if (!draft.orTriggers.length) delete draft.orTriggers;
    renderEditor();
  }));
  $('#add-or').onclick = () => {
    (draft.orTriggers ??= []).push(blankTrigger(draft.trigger.source === 'time' ? 'webhook' : 'time'));
    renderEditor();
  };
  dlg.querySelectorAll('[data-list]').forEach((el) => {
    el.onchange = () => {
      const path = el.dataset.list;
      const val = el.hasAttribute('data-num') ? Number(el.value) : el.value;
      const raw = getPath(draft, path);
      const cur = raw == null ? (path.endsWith('.days') ? [0, 1, 2, 3, 4, 5, 6] : []) : [raw].flat();
      const set = new Set(cur);
      el.checked ? set.add(val) : set.delete(val);
      let next = [...set];
      if (path.endsWith('.days')) next = next.length === 7 ? undefined : next.sort();
      const isMode = /^(conditions|orConditions\.\d+)\.mode$/.test(path);
      if (isMode) next = next.length ? next : undefined;
      setPath(draft, path, next);
      if (isMode) renderEditor();
    };
  });
  dlg.querySelectorAll('[data-steptype]').forEach((el) => (el.onchange = () => {
    const i = +el.dataset.steptype;
    const targets = draft.steps[i].targets;
    draft.steps[i] = newStep(el.value);
    if (targets && (el.value === 'set' || el.value === 'pulse')) draft.steps[i].targets = targets;
    renderEditor();
  }));
  dlg.querySelectorAll('[data-mode]').forEach((el) => (el.onchange = () => {
    const s = draft.steps[+el.dataset.mode];
    delete s.kelvin;
    delete s.color;
    if (el.value === 'kelvin') s.kelvin = 4000;
    if (el.value === 'color') s.color = '#ff8a3d';
    renderEditor();
  }));
  dlg.querySelectorAll('[data-rokumode]').forEach((el) => (el.onchange = () => {
    const st = draft.steps[+el.dataset.rokumode];
    if (el.value === 'app') {
      delete st.key;
      st.app = 'plex';
    } else {
      delete st.app;
      st.key = 'Play';
    }
    renderEditor();
  }));
  dlg.querySelectorAll('[data-customtargets]').forEach((el) => (el.onchange = () => {
    const s = draft.steps[+el.dataset.customtargets];
    if (el.checked) s.targets = [...(draft.targets ?? [])];
    else delete s.targets;
    renderEditor();
  }));
  dlg.querySelectorAll('[data-addstep]').forEach((el) => (el.onclick = () => {
    draft.steps.push(newStep(el.dataset.addstep));
    renderEditor();
  }));
  dlg.querySelectorAll('[data-delstep]').forEach((el) => (el.onclick = () => {
    draft.steps.splice(+el.dataset.delstep, 1);
    renderEditor();
  }));
  dlg.querySelectorAll('[data-move]').forEach((el) => (el.onclick = () => {
    const [i, dir] = el.dataset.move.split(':').map(Number);
    const [s] = draft.steps.splice(i, 1);
    draft.steps.splice(i + dir, 0, s);
    renderEditor();
  }));
  dlg.querySelectorAll('[data-tw]').forEach((el) => (el.onchange = () => {
    const path = el.dataset.tw;
    if (el.checked) setPath(draft, `${path}.timeWindow`, { from: '17:00', to: '06:00' });
    else delete getPath(draft, path)?.timeWindow;
    renderEditor();
  }));
  $('#add-orc').onclick = () => {
    (draft.orConditions ??= []).push({});
    renderEditor();
  };
  dlg.querySelectorAll('[data-delorc]').forEach((el) => (el.onclick = () => {
    draft.orConditions.splice(+el.dataset.delorc, 1);
    if (!draft.orConditions.length) delete draft.orConditions;
    renderEditor();
  }));
  $('#cancel-edit').onclick = () => dlg.close();
  const validate = () => {
    if (!draft.name?.trim()) throw new Error('Give the workflow a name');
    if (!draft.trigger.event) throw new Error('Pick what should trigger it');
    if (draft.orTriggers?.some((t) => !t.event)) throw new Error('Finish or remove the extra “Or when…” trigger');
    if (!draft.steps.length) throw new Error('Add at least one THEN step');
  };
  $('#test-routine').onclick = guard(async () => {
    validate();
    const routines = clone(S.state.routines);
    const tmp = { ...clone(draft), id: draft.id ?? `test-${Date.now()}`, name: `${draft.name} (test)`, trigger: { source: 'webhook', event: `__test_${Date.now()}` }, orTriggers: undefined };
    await api('PUT', '/api/routines', [...routines, tmp]);
    await api('POST', '/api/routines/run', { id: tmp.id }).catch(() => {});
    await api('PUT', '/api/routines', routines);
    toast('Testing — watch your lights / the Activity tab');
  });
  $('#save-routine').onclick = guard(async () => {
    validate();
    const routines = clone(S.state.routines);
    if (draftIndex == null) routines.push(draft);
    else routines[draftIndex] = draft;
    await saveRoutines(routines);
    dlg.close();
    toast('Saved — it’s live');
  });
  const del = $('#del-routine');
  if (del) del.onclick = guard(async () => {
    if (!confirm(`Delete "${draft.name}"?`)) return;
    const routines = clone(S.state.routines);
    routines.splice(draftIndex, 1);
    await saveRoutines(routines);
    dlg.close();
  });
}

function newStep(type) {
  if (type === 'pulse') return { type, levels: [100, 70, 100], times: 3, stepMs: 1000, restore: true };
  if (type === 'wait') return { type, ms: 1000 };
  if (type === 'http') return { type, method: 'POST', url: '' };
  if (type === 'ha') return { type, service: 'switch.turn_on', data: { entity_id: '' } };
  if (type === 'notify') return { type, message: '', priority: 3 };
  if (type === 'mode') return { type, mode: S.state.modes.find((m) => m !== S.state.mode) ?? S.state.modes[0] };
  if (type === 'scene') return { type, scene: S.state.scenes?.[0]?.name ?? '', transitionMs: 2000 };
  if (type === 'capture') return { type, scene: '' };
  if (type === 'mqtt') return { type, topic: '', payload: '' };
  if (type === 'plex') return { type, action: 'pause' };
  if (type === 'roku') return { type, device: S.state.rokus?.length === 1 ? S.state.rokus[0].name : '', key: 'Play' };
  return { type: 'set', brightness: 50, transitionMs: 3000 };
}

// ---------- network ----------
function renderNetwork() {
  const el = $('#tab-network');
  const q = S.netFilter.toLowerCase();
  const list = S.network.filter((d) => (!S.netOnline || d.online) && (!q || [d.name, d.hostname, d.ip, d.mac, d.label, d.vendor].some((v) => String(v ?? '').toLowerCase().includes(q))));
  const st = S.state.network.status;
  const isNew = (d) => d.isNew && Date.now() - Date.parse(d.firstSeen) < 86_400_000;
  const action = (d) => {
    if (d.kind === 'hue-bridge') return `<button class="btn sm" data-goto="connections">Set up Hue</button>`;
    if (d.kind === 'home-assistant') return `<button class="btn sm" data-goto="connections">Connect</button>`;
    if (d.kind === 'plex-server') return `<button class="btn sm" data-goto="connections">Connect Plex</button>`;
    return '';
  };
  el.innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <div><h2>Network</h2><p class="sub" style="margin:0">Always scanning — ${S.network.filter((d) => d.online).length} online of ${S.network.length} seen · last scan ${st.lastCycle ? ago(st.lastCycle) : '…'}</p></div>
      <button class="btn" id="net-scan">Scan now</button>
    </div>
    <div class="row" style="margin-bottom:12px">
      <input type="text" id="net-q" placeholder="Search name, IP, type…" value="${esc(S.netFilter)}" style="flex:1;min-width:180px">
      <label class="row small"><input type="checkbox" id="net-online" ${S.netOnline ? 'checked' : ''}> Online only</label>
    </div>
    <div class="devices">
      ${list.map((d) => `
        <div class="device card ${d.online ? '' : 'off'}">
          <div class="dev-icon">${KIND_ICON[d.kind] ?? '❔'}</div>
          <div class="dev-main">
            <div class="row" style="gap:6px"><b>${esc(d.name ?? d.hostname ?? d.ip)}</b>${isNew(d) ? '<span class="chip new">NEW</span>' : ''}</div>
            <div class="small muted">${esc(d.label)} · ${esc(d.ip)}${d.vendor && !d.vendor.startsWith('Private') ? ` · ${esc(d.vendor)}` : ''}</div>
            <div class="small muted"><span class="dot ${d.online ? 'ok' : ''}"></span> ${d.online ? 'online' : `last seen ${ago(d.lastSeen)}`}</div>
          </div>
          <div class="dev-actions">
            ${action(d)}
            <button class="btn sm" data-netwf="${esc(d.key)}" title="IF this device comes home THEN…">+ Workflow</button>
            <button class="btn sm ghost" data-netname="${esc(d.key)}" title="Rename">✎</button>
          </div>
        </div>`).join('') || '<div class="card empty">Nothing yet — the first scan takes a few seconds.</div>'}
    </div>`;
  $('#net-scan').onclick = guard(async (e) => busy(e.target, 'Scanning…', async () => {
    const res = await api('POST', '/api/network/scan');
    S.network = res.devices;
    renderNetwork();
  }));
  $('#net-q').oninput = (e) => {
    S.netFilter = e.target.value;
    renderNetwork();
    $('#net-q').focus();
    $('#net-q').setSelectionRange(S.netFilter.length, S.netFilter.length);
  };
  $('#net-online').onchange = (e) => {
    S.netOnline = e.target.checked;
    renderNetwork();
  };
  el.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => showTab(b.dataset.goto)));
  el.querySelectorAll('[data-netwf]').forEach((b) => (b.onclick = () => {
    const d = S.network.find((x) => x.key === b.dataset.netwf);
    openEditor(null, {
      name: `${d.name ?? d.ip} comes home`,
      enabled: true,
      trigger: { source: 'network', event: 'device.online', device: d.name ?? d.ip },
      cooldownSec: 600,
      targets: [],
      steps: [{ type: 'set', brightness: 80, kelvin: 2700, transitionMs: 2000 }],
    });
  }));
  el.querySelectorAll('[data-netname]').forEach((b) => (b.onclick = guard(async () => {
    const d = S.network.find((x) => x.key === b.dataset.netname);
    const name = prompt('Name this device', d.name ?? '');
    if (name == null) return;
    await api('POST', '/api/network/rename', { key: d.key, name });
    await refreshNetwork();
  })));
}

// ---------- lights & groups ----------
function renderLights() {
  const el = $('#tab-lights');
  const lightRow = (l) => `
    <div class="row spread check" style="cursor:default">
      <span>${esc(l.name)}<br><small>${esc(l.kind.replace('-', ' '))}${l.ip ? ` · ${esc(l.ip)}` : ''}${l.reachable === false ? ' · unreachable' : ''}</small></span>
      <span class="row">
        ${l.kind === 'govee' || l.kind === 'wled' ? `<button class="btn sm ghost" data-rename="${esc(l.id)}">Rename</button>` : ''}
        <button class="btn sm" data-identify="${esc(l.id)}">Identify</button>
      </span>
    </div>`;
  el.innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <div><h2>Groups</h2><p class="sub" style="margin:0">Mix Hue, Govee, WLED and Home Assistant lights into named groups. Groups also show up in Alexa.</p></div>
      <button class="btn primary" id="add-group">+ New group</button>
    </div>
    <div class="stack" id="groups">
      ${S.groups.map((g, gi) => `
        <div class="card">
          <div class="row spread" style="margin-bottom:10px">
            <input type="text" value="${esc(g.name)}" data-gname="${gi}" style="font-weight:600">
            <div class="row"><span class="muted small"><code>group:${esc(g.id)}</code></span>
            <button class="btn sm" data-identify="group:${esc(g.id)}">Identify</button>
            <button class="btn sm ghost danger" data-gdel="${gi}">Delete</button></div>
          </div>
          ${S.lights.length ? `<div class="checks">${S.lights.map((l) => `
            <label class="check"><input type="checkbox" data-gmember="${gi}" value="${esc(l.id)}" ${g.members.includes(l.id) ? 'checked' : ''}>
            <span>${esc(l.name)}<br><small>${esc(l.kind.replace('-', ' '))}</small></span></label>`).join('')}</div>`
            : '<p class="muted small">Connect Hue, Govee or Home Assistant first.</p>'}
        </div>`).join('')}
    </div>
    <div class="row spread" style="margin:28px 0 14px">
      <div><h2>Scenes</h2><p class="sub" style="margin:0">Save how the lights look right now, then bring it back with a tap, a “🎬 Scene” workflow step, or Siri.</p></div>
      <button class="btn primary" id="add-scene">+ Save current lights</button>
    </div>
    <div class="card stack" id="scene-form" hidden>
      <label class="field">Scene name<input type="text" id="scene-name" placeholder="e.g. Reading, Dinner, Movie night"></label>
      <div class="small muted">Which lights</div>
      ${targetPicker([], 'sceneTargets')}
      <div class="row"><button class="btn primary" id="scene-save">Save scene</button><button class="btn" id="scene-cancel">Cancel</button></div>
    </div>
    <div class="stack">
      ${(S.state.scenes ?? []).map((x) => `
        <div class="card row spread">
          <span>🎬 <b>${esc(x.name)}</b><br><small class="muted">${x.lights.length} light${x.lights.length === 1 ? '' : 's'} · ${esc(x.lights.map(targetName).join(', '))} · saved ${esc(new Date(x.savedAt).toLocaleString())}</small></span>
          <span class="row">
            <button class="btn sm primary" data-sapply="${esc(x.id)}">Apply</button>
            <button class="btn sm" data-sresave="${esc(x.id)}" title="Save the lights' current look into this scene">Update</button>
            <button class="btn sm ghost danger" data-sdel="${esc(x.id)}">Delete</button>
          </span>
        </div>`).join('') || '<p class="muted small">No scenes yet.</p>'}
    </div>
    <h2 style="margin-top:28px">All lights</h2>
    <p class="sub">“Identify” blinks a light so you can tell which is which.</p>
    <div class="checks">${S.lights.map(lightRow).join('') || '<p class="muted">No lights found yet.</p>'}</div>`;

  const saveGroups = guard(async () => {
    const res = await api('PUT', '/api/groups', S.groups);
    S.groups = res.groups;
  });
  $('#add-group').onclick = guard(async () => {
    const name = prompt('Group name (e.g. Kitchen)');
    if (!name) return;
    S.groups.push({ name, members: [] });
    await saveGroups();
    renderLights();
  });
  el.querySelectorAll('[data-gname]').forEach((i) => (i.onchange = () => {
    S.groups[+i.dataset.gname].name = i.value;
    saveGroups();
  }));
  el.querySelectorAll('[data-gmember]').forEach((c) => (c.onchange = () => {
    const g = S.groups[+c.dataset.gmember];
    g.members = c.checked ? [...new Set([...g.members, c.value])] : g.members.filter((m) => m !== c.value);
    saveGroups();
  }));
  el.querySelectorAll('[data-gdel]').forEach((b) => (b.onclick = guard(async () => {
    const g = S.groups[+b.dataset.gdel];
    if (!confirm(`Delete group "${g.name}"? Workflows using it will have no lights.`)) return;
    S.groups.splice(+b.dataset.gdel, 1);
    await saveGroups();
    renderLights();
  })));
  const reloadScenes = async () => {
    S.state.scenes = (await api('GET', '/api/state')).scenes;
    renderLights();
  };
  const saveScene = async (name, targets) => {
    const res = await api('POST', '/api/scenes', { name, targets });
    toast(res.skipped.length ? `Saved — couldn't read ${res.skipped.map(targetName).join(', ')}` : `Saved scene “${name}”`, res.skipped.length > 0);
    await reloadScenes();
  };
  $('#add-scene').onclick = () => {
    $('#scene-form').hidden = false;
    $('#scene-name').focus();
  };
  $('#scene-cancel').onclick = () => ($('#scene-form').hidden = true);
  $('#scene-save').onclick = guard(async () => {
    const name = $('#scene-name').value.trim();
    const targets = [...el.querySelectorAll('#scene-form [data-list]:checked')].map((c) => c.value);
    if (!name) throw new Error('Give the scene a name');
    if (!targets.length) throw new Error('Pick at least one light');
    if ((S.state.scenes ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase()) && !confirm(`Replace the scene “${name}”?`)) return;
    await busy($('#scene-save'), 'Saving…', () => saveScene(name, targets));
  });
  el.querySelectorAll('[data-sapply]').forEach((b) => (b.onclick = guard(() => busy(b, '…', () => api('POST', '/api/scenes/apply', { id: b.dataset.sapply, transitionMs: 1000 })))));
  el.querySelectorAll('[data-sresave]').forEach((b) => (b.onclick = guard(async () => {
    const x = S.state.scenes.find((y) => y.id === b.dataset.sresave);
    if (confirm(`Replace “${x.name}” with how its lights look right now?`)) await saveScene(x.name, x.lights);
  })));
  el.querySelectorAll('[data-sdel]').forEach((b) => (b.onclick = guard(async () => {
    const x = S.state.scenes.find((y) => y.id === b.dataset.sdel);
    if (!confirm(`Delete scene “${x.name}”? Workflow steps using it will be skipped.`)) return;
    await api('POST', '/api/scenes/delete', { id: x.id });
    await reloadScenes();
  })));
  el.querySelectorAll('[data-identify]').forEach((b) => (b.onclick = guard(async () => {
    await busy(b, '…', () => api('POST', '/api/lights/identify', { target: b.dataset.identify }));
  })));
  el.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = guard(async () => {
    const [kind, id] = [b.dataset.rename.slice(0, b.dataset.rename.indexOf(':')), b.dataset.rename.slice(b.dataset.rename.indexOf(':') + 1)];
    const name = prompt('Name for this light', targetName(b.dataset.rename));
    if (!name) return;
    await api('POST', `/api/${kind}/rename`, { id, name });
    await refreshLights();
  })));
}

// ---------- connections ----------
function statusPill(ok, text, bad = false) {
  return `<span class="pill"><span class="dot ${ok ? 'ok' : bad ? 'bad' : ''}"></span>${text}</span>`;
}

function renderConnections() {
  const el = $('#tab-connections');
  const { plex, hue, govee, wled, urls, homeassistant: ha, alexa, ai, ntfy, mqtt, location: loc, sky } = S.state;
  const ntfyWeb = `${(ntfy.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(ntfy.topic || '')}`;
  const alexaOk = alexa.status.http === 'listening';
  el.innerHTML = `
    <div class="grid2">
      <div class="card stack">
        <div class="row spread"><h2>🎬 Plex</h2>${statusPill(plex.status.connected, plex.status.connected ? `${plex.status.socket === 'live' ? 'Live' : 'Polling'} · ${plex.status.sessions} playing` : plex.hasToken ? 'Unreachable' : 'Not connected', plex.hasToken && !plex.status.connected)}</div>
        ${plex.status.lastError && plex.hasToken ? `<p class="small" style="color:var(--bad);margin:0">${esc(plex.status.lastError)}</p>` : ''}
        <button class="btn primary" id="plex-signin">Sign in with Plex</button>
        <div id="plex-servers"></div>
        <details><summary class="small muted">Or enter server address &amp; token manually</summary>
          <div class="fields" style="margin-top:10px">
            <label class="field grow">Server URL<input type="text" id="plex-url" value="${esc(plex.url)}" placeholder="http://192.168.1.10:32400"></label>
            <label class="field grow">X-Plex-Token<input type="password" id="plex-token" placeholder="${plex.hasToken ? '•••••• (saved)' : ''}"></label>
            <button class="btn" id="plex-save">Save</button>
          </div></details>
        <div class="small muted">Players Plex sees: ${plex.status.players?.length ? plex.status.players.map(esc).join(', ') : '—'}</div>
        <details><summary class="small muted">Faster events with Plex Pass webhooks (optional)</summary>
          <p class="small muted">Plex Web → Settings → Webhooks → Add Webhook:</p>${copyBox(urls.plexWebhook[0])}</details>
      </div>

      <div class="card stack">
        <div class="row spread"><h2>🏠 Home Assistant</h2>${statusPill(ha.status.connected, ha.status.connected ? `Connected · ${ha.status.entities} entities` : ha.hasToken ? 'Not connected' : 'Not set up', ha.hasToken && !ha.status.connected)}</div>
        ${ha.candidates.length && !ha.status.connected ? `<p class="small" style="margin:0">🔎 Found on your network: <b>${ha.candidates.map(esc).join(', ')}</b></p>` : ''}
        <p class="small muted" style="margin:0">In Home Assistant: click your profile (bottom-left) → <b>Security</b> → <b>Long-lived access tokens</b> → Create token.</p>
        <div class="fields">
          <label class="field grow">URL<input type="text" id="ha-url" value="${esc(ha.url || ha.candidates[0] || '')}" placeholder="http://homeassistant.local:8123"></label>
          <label class="field grow">Access token<input type="password" id="ha-token" placeholder="${ha.hasToken ? '•••••• (saved)' : 'paste token'}"></label>
          <button class="btn primary" id="ha-save">Connect</button>
        </div>
        ${ha.status.lastError && ha.hasToken ? `<p class="small" style="color:var(--bad);margin:0">${esc(ha.status.lastError)}</p>` : ''}
        <details><summary class="small muted">Let Home Assistant trigger Playlite</summary>
          <p class="small muted">Add to <code>configuration.yaml</code>, then call <code>rest_command.playlite</code> from any HA automation with <code>name: doorbell</code>:</p>
          <pre class="code">rest_command:\n  playlite:\n    url: "${esc(urls.hook.replace('<name>', '{{ name }}'))}"\n    method: POST</pre></details>
      </div>

      <div class="card stack">
        <div class="row spread"><h2>💡 Philips Hue</h2>${statusPill(hue.paired, hue.paired ? `Paired · ${esc(hue.bridgeIp)}` : 'Not paired')}</div>
        ${!hue.paired && hue.candidates.length ? `<p class="small" style="margin:0">🔎 Found: <b>${hue.candidates.map(esc).join(', ')}</b></p>` : ''}
        <p class="small muted" style="margin:0"><b>Press the round button on top of the bridge</b>, then click Pair within 30 seconds.</p>
        <div class="fields">
          <label class="field grow">Bridge IP<input type="text" id="hue-ip" value="${esc(hue.bridgeIp || hue.candidates[0] || '')}" placeholder="192.168.1.20"></label>
          <button class="btn" id="hue-find">Find</button>
          <button class="btn primary" id="hue-pair">Pair</button>
        </div>
        ${hue.paired ? `<p class="small muted" style="margin:0">🔘 Sensors &amp; buttons: ${hue.sensors.connected ? `listening · ${hue.sensors.devices.length ? esc(hue.sensors.devices.map((x) => x.name).join(', ')) : 'none paired to the bridge'}` : `<span style="color:var(--warn)">not connected${hue.sensors.lastError ? ` — ${esc(hue.sensors.lastError)}` : ''}</span>`}</p>` : ''}
      </div>

      <div class="card stack">
        <div class="row spread"><h2>🌈 WLED</h2>${statusPill(wled.devices.length, `${wled.devices.length} added`)}</div>
        <p class="small muted" style="margin:0">LED strips running <b>WLED</b> — fades, colors and white tones work like any other light.</p>
        ${wled.candidates.length ? `<div class="small">🔎 Found on your network: ${wled.candidates.map((c) => `<button class="btn sm" data-wledadd="${esc(c.ip)}">+ ${esc(c.name ?? c.ip)}</button>`).join(' ')}</div>` : ''}
        <div class="fields">
          <label class="field grow">Add by IP<input type="text" id="wled-ip" placeholder="192.168.1.60"></label>
          <button class="btn" id="wled-add">Add</button>
        </div>
        ${wled.devices.map((d) => `<div class="row spread small"><span>${esc(d.name)} <span class="muted">${esc(d.ip)}${d.leds ? ` · ${d.leds} LEDs` : ''}</span></span><button class="btn sm ghost danger" data-wremove="${esc(d.id)}">Remove</button></div>`).join('')}
      </div>

      <div class="card stack">
        <div class="row spread"><h2>💡 Govee</h2>${statusPill(govee.devices.length, `${govee.devices.length} found`)}</div>
        <p class="small muted" style="margin:0">Govee Home app → each light → ⚙ → turn on <b>LAN Control</b>. Then scan.</p>
        <div class="row"><button class="btn primary" id="govee-scan">Scan</button></div>
        <div class="fields">
          <label class="field grow">Add by IP<input type="text" id="govee-ip" placeholder="192.168.1.55"></label>
          <button class="btn" id="govee-add">Add</button>
        </div>
        ${govee.devices.map((d) => `<div class="row spread small"><span>${esc(d.name)} <span class="muted">${esc(d.sku)} · ${esc(d.ip)}</span></span><button class="btn sm ghost danger" data-gremove="${esc(d.id.slice(6))}">Remove</button></div>`).join('')}
      </div>

      <div class="card stack">
        <div class="row spread"><h2>🗣 Alexa</h2>${statusPill(alexaOk, alexaOk ? `Ready · port ${alexa.status.port}` : alexa.enabled ? 'Not running' : 'Off', alexa.enabled && !alexaOk)}</div>
        <p class="small muted" style="margin:0">Playlite shows up to Echo devices as a Hue bridge — no skill or account needed. Say <b>“Alexa, discover devices”</b>, then:</p>
        <ul class="small" style="margin:0;padding-left:18px">${alexa.items.slice(0, 8).map((i) => `<li>“Alexa, ${i.kind === 'routine' ? `turn on ${esc(i.name)}` : `set ${esc(i.name)} to 30%`}”</li>`).join('') || '<li class="muted">Add groups or give a workflow a voice name.</li>'}</ul>
        ${alexa.status.http.startsWith('error') ? `<p class="small" style="color:var(--bad);margin:0">${esc(alexa.status.http)}. Newer Echos need port 80 — run Playlite as admin, or stop whatever uses port 80.</p>` : ''}
        <div class="fields">
          <label class="row small"><input type="checkbox" id="alexa-on" ${alexa.enabled ? 'checked' : ''}> Enabled</label>
          <label class="field">Port<input type="number" id="alexa-port" value="${alexa.port}"></label>
          <button class="btn" id="alexa-save">Save</button>
        </div>
      </div>

      <div class="card stack">
        <h2>🍎 Siri &amp; Shortcuts</h2>
        <p class="small muted" style="margin:0">In the iPhone <b>Shortcuts</b> app: New Shortcut → <b>Get Contents of URL</b> → paste a link below → name the shortcut (that's what you say to Siri).</p>
        <div class="small"><b>Run a workflow</b> — e.g. “Hey Siri, Movie Mode”:</div>
        ${copyBox(urls.run.replace('<workflow>', encodeURIComponent(S.state.routines.find((r) => r.voiceName)?.voiceName ?? 'Movie Mode')))}
        <div class="small"><b>Switch the house mode</b> — e.g. “Hey Siri, movie mode” (change <code>movie</code> to any mode):</div>
        ${copyBox(urls.mode.replace('<mode>', 'movie'))}
        <div class="small"><b>Turn on a scene</b> — e.g. “Hey Siri, reading lights” (add <code>&amp;fade=3</code> to fade over 3 s):</div>
        ${copyBox(urls.scene.replace('<scene>', encodeURIComponent(S.state.scenes?.[0]?.name ?? 'Reading')))}
        <div class="small"><b>Ask Playlite anything</b> — add <i>Dictate Text</i> first, put it after <code>q=</code>, then <i>Speak Text</i> the result:</div>
        ${copyBox(urls.ask)}
        <p class="small muted" style="margin:0">Also great as iPhone Personal Automations: arrive home, leave, alarm stopped, Focus on, NFC tag tapped.</p>
      </div>

      <div class="card stack">
        <div class="row spread"><h2>📡 MQTT</h2>${statusPill(mqtt.status.connected, mqtt.status.connected ? `Connected · ${mqtt.topics} topics` : mqtt.url ? esc(mqtt.status.lastError ?? 'Connecting…') : 'Not set up', Boolean(mqtt.url && !mqtt.status.connected))}</div>
        <p class="small muted" style="margin:0">Point Playlite at your MQTT broker (e.g. Mosquitto) to use <b>Zigbee2MQTT</b> sensors and buttons, <b>Tasmota</b>/<b>Shelly</b> plugs, <b>ESPHome</b>, <b>Frigate</b>, <b>rtl_433</b>… as triggers, and to send them commands.</p>
        <div class="fields">
          <label class="field grow">Broker<input type="text" id="mqtt-url" value="${esc(mqtt.url)}" placeholder="mqtt://192.168.1.10:1883"></label>
          <label class="field">Username<input type="text" id="mqtt-user" value="${esc(mqtt.username)}" placeholder="optional" autocomplete="off"></label>
          <label class="field">Password<input type="password" id="mqtt-pass" placeholder="${mqtt.hasPassword ? '•••••• (saved)' : 'optional'}" autocomplete="new-password"></label>
          <button class="btn primary" id="mqtt-save">Save</button>
        </div>
        ${mqtt.status.connected ? '<details id="mqtt-browse"><summary class="small muted">Recent topics</summary><div id="mqtt-topics" class="small" style="margin-top:8px">Loading…</div></details>' : ''}
        <p class="small muted" style="margin:0">Use <code>mqtts://</code> for TLS. Leave the broker empty to turn MQTT off.</p>
      </div>

      <div class="card stack">
        <div class="row spread"><h2>📲 Phone alerts</h2>${statusPill(Boolean(ntfy.topic), ntfy.topic ? 'Ready' : 'Not set up')}</div>
        <p class="small muted" style="margin:0">Uses <b>ntfy</b> — free, no account. Install the ntfy app (iPhone or Android), tap <b>+</b>, and subscribe to the same topic name you enter here. Then add a “📲 Phone alert” step to any workflow.</p>
        <div class="fields">
          <label class="field grow">Topic<input type="text" id="ntfy-topic" value="${esc(ntfy.topic)}" placeholder="e.g. playlite-${Math.random().toString(36).slice(2, 8)}"></label>
          <button class="btn primary" id="ntfy-save">Save</button>
          <button class="btn" id="ntfy-test" ${ntfy.topic ? '' : 'disabled'}>Send test</button>
        </div>
        <p class="small muted" style="margin:0">On the public ntfy.sh server <b>anyone who knows the topic can read your alerts</b> — pick something hard to guess.${ntfy.topic ? ` Also viewable at <code>${esc(ntfyWeb)}</code>.` : ''}</p>
        <details><summary class="small muted">Self-hosted server or access token (optional)</summary>
          <div class="fields" style="margin-top:10px">
            <label class="field grow">Server<input type="text" id="ntfy-server" value="${esc(ntfy.server)}" placeholder="https://ntfy.sh"></label>
            <label class="field grow">Access token<input type="password" id="ntfy-token" placeholder="${ntfy.hasToken ? '•••••• (saved)' : 'tk_…'}"></label>
          </div></details>
      </div>

      <div class="card stack">
        <div class="row spread"><h2>🤖 AI</h2>${statusPill(ai.ready, ai.ready ? 'Ready' : 'Needs API key')}</div>
        <p class="small muted" style="margin:0">Powers “Got an idea?” and Siri questions. Get a key at <b>console.anthropic.com</b>.</p>
        <div class="fields">
          <label class="field grow">Claude API key<input type="password" id="ai-key" placeholder="${ai.fromEnv ? 'using ANTHROPIC_API_KEY' : ai.ready ? '•••••• (saved)' : 'sk-ant-…'}"></label>
          <label class="field">Model<input type="text" id="ai-model" value="${esc(ai.model)}"></label>
          <button class="btn" id="ai-save">Save</button>
        </div>
        <div class="small"><b>Use Playlite from Claude (MCP)</b> — Claude Code:</div>
        ${copyBox(`claude mcp add --transport http playlite "${urls.mcp}"`)}
        <p class="small muted" style="margin:0">Any MCP client works with that URL — agents can list lights, run and create workflows, see network devices and call Home Assistant.</p>
      </div>

      <div class="card stack">
        <h2>📍 Location</h2>
        <p class="small muted" style="margin:0">Used for sunrise/sunset and “only when dark”. Computed on this PC — nothing is sent anywhere after lookup.</p>
        <div class="fields">
          <label class="field grow">City or ZIP<input type="text" id="loc-q" placeholder="${esc(loc?.name || 'e.g. Nashville')}"></label>
          <button class="btn" id="loc-find">Look up</button>
        </div>
        <div id="loc-results"></div>
        ${loc?.lat ? `<div class="sky"><span>📍 ${esc(loc.name || `${loc.lat}, ${loc.lon}`)}</span><span>🌅 ${timeOf(sky.sunrise)}</span><span>🌇 ${timeOf(sky.sunset)}</span><span>${sky.moon === 'Full moon' ? '🌕' : '🌙'} ${esc(sky.moon)}</span></div>` : '<p class="small" style="color:var(--warn);margin:0">Not set yet.</p>'}
      </div>

      <div class="card stack">
        <h2>🔗 Webhooks</h2>
        <p class="small muted" style="margin:0">Fire any “Webhook” workflow from IFTTT, Zapier, n8n, Stream Deck, Tasker…</p>
        ${copyBox(urls.hook)}
        <p class="small muted" style="margin:0">Open Playlite from any device on your network: ${urls.ui.map((u) => `<code>${esc(u)}</code>`).join(' ')}</p>
      </div>
    </div>`;

  wireCopy(el);
  $('#plex-signin').onclick = guard(async () => {
    const popup = window.open('about:blank', 'plexauth', 'width=600,height=720');
    const pin = await api('POST', '/api/plex/pin');
    if (popup) popup.location = pin.authUrl;
    else window.open(pin.authUrl, '_blank');
    toast('Finish signing in in the Plex window…');
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await api('POST', '/api/plex/pin/check', { id: pin.id });
      if (res.done) {
        popup?.close();
        showServers(res.servers);
        return;
      }
    }
    throw new Error('Plex sign-in timed out');
  });
  $('#plex-save').onclick = guard(async () => {
    await api('POST', '/api/plex/settings', { url: $('#plex-url').value.trim(), token: $('#plex-token').value.trim() || undefined });
    toast('Plex settings saved');
    await refresh();
  });
  $('#ha-save').onclick = guard(async (e) => busy(e.target, 'Connecting…', async () => {
    const res = await api('POST', '/api/ha/settings', { url: $('#ha-url').value.trim(), token: $('#ha-token').value.trim() || undefined });
    toast(`Connected to Home Assistant ${res.info.version ?? ''}`);
    setTimeout(() => Promise.all([refresh(), refreshLights()]), 1500);
  }));
  $('#hue-find').onclick = guard(async () => {
    const bridges = await api('POST', '/api/hue/discover');
    if (!bridges.length) throw new Error('No bridge found automatically — check your router for its IP');
    $('#hue-ip').value = bridges[0].ip;
    toast(`Found bridge at ${bridges[0].ip}`);
  });
  $('#hue-pair').onclick = guard(async () => {
    await api('POST', '/api/hue/pair', { ip: $('#hue-ip').value.trim() });
    toast('Hue bridge paired!');
    await Promise.all([refresh(), refreshLights()]);
  });
  $('#govee-scan').onclick = guard(async (e) => busy(e.target, 'Scanning…', async () => {
    const res = await api('POST', '/api/govee/scan');
    toast(`Found ${res.found.length} Govee device${res.found.length === 1 ? '' : 's'}`);
    await Promise.all([refresh(), refreshLights()]);
  }));
  const addWled = (ip, btn) => guard(async () => busy(btn, 'Adding…', async () => {
    await api('POST', '/api/wled/add', { ip });
    toast('WLED added');
    await Promise.all([refresh(), refreshLights()]);
  }))();
  $('#wled-add').onclick = (e) => addWled($('#wled-ip').value.trim(), e.target);
  el.querySelectorAll('[data-wledadd]').forEach((b) => (b.onclick = () => addWled(b.dataset.wledadd, b)));
  el.querySelectorAll('[data-wremove]').forEach((b) => (b.onclick = guard(async () => {
    await api('POST', '/api/wled/remove', { id: b.dataset.wremove });
    await Promise.all([refresh(), refreshLights()]);
  })));
  $('#govee-add').onclick = guard(async () => {
    await api('POST', '/api/govee/add', { ip: $('#govee-ip').value.trim() });
    toast('Added');
    await Promise.all([refresh(), refreshLights()]);
  });
  el.querySelectorAll('[data-gremove]').forEach((b) => (b.onclick = guard(async () => {
    await api('POST', '/api/govee/remove', { id: b.dataset.gremove });
    await Promise.all([refresh(), refreshLights()]);
  })));
  $('#alexa-save').onclick = guard(async () => {
    await api('POST', '/api/alexa/settings', { enabled: $('#alexa-on').checked, port: +$('#alexa-port').value });
    setTimeout(refresh, 800);
    toast('Saved');
  });
  $('#mqtt-save').onclick = guard(async (e) => busy(e.target, 'Connecting…', async () => {
    const body = { url: $('#mqtt-url').value.trim(), username: $('#mqtt-user').value.trim() };
    if ($('#mqtt-pass').value) body.password = $('#mqtt-pass').value;
    await api('POST', '/api/mqtt/settings', body);
    toast(body.url ? 'MQTT connected' : 'MQTT turned off');
    S.mqttTopics = null;
    setTimeout(refresh, 600);
  }));
  $('#mqtt-browse')?.addEventListener('toggle', guard(async (e) => {
    if (!e.target.open) return;
    const list = await api('GET', '/api/mqtt/topics');
    $('#mqtt-topics').innerHTML = list.slice(0, 80).map((t) => `<div class="mqtt-row"><code>${esc(t.topic)}</code> <span class="muted">${esc(t.payload.slice(0, 140))}</span></div>`).join('') || '<span class="muted">No messages yet.</span>';
  }));
  $('#ntfy-save').onclick = guard(async () => {
    const body = { topic: $('#ntfy-topic').value.trim(), server: $('#ntfy-server').value.trim() };
    if ($('#ntfy-token').value.trim()) body.token = $('#ntfy-token').value.trim();
    await api('POST', '/api/ntfy/settings', body);
    toast('Phone alerts saved');
    await refresh();
  });
  $('#ntfy-test').onclick = guard(async (e) => busy(e.target, 'Sending…', async () => {
    await api('POST', '/api/ntfy/test');
    toast('Test alert sent — check your phone');
  }));
  $('#ai-save').onclick = guard(async () => {
    const body = { model: $('#ai-model').value.trim() };
    if ($('#ai-key').value.trim()) body.apiKey = $('#ai-key').value.trim();
    await api('POST', '/api/ai/settings', body);
    toast('Saved');
    await refresh();
  });
  $('#loc-find').onclick = guard(async () => {
    const results = await api('GET', `/api/location/search?q=${encodeURIComponent($('#loc-q').value)}`);
    $('#loc-results').innerHTML = results.length
      ? results.map((r, i) => `<button class="btn sm" data-loc="${i}" style="margin:2px">${esc(r.name)}</button>`).join('')
      : '<p class="small muted">No matches.</p>';
    $('#loc-results').querySelectorAll('[data-loc]').forEach((b) => (b.onclick = guard(async () => {
      await api('POST', '/api/location', results[+b.dataset.loc]);
      toast('Location saved');
      await refresh();
    })));
  });
}

function showServers(servers) {
  const box = $('#plex-servers');
  if (!servers.length) {
    box.innerHTML = '<p class="small" style="color:var(--bad)">Signed in, but no Plex servers were found on this account.</p>';
    return;
  }
  box.innerHTML = `<div class="stack">${servers.map((s) => `
    <div class="step"><b>${esc(s.name)}</b>
      ${s.connections.map((c) => `<label class="row small"><input type="radio" name="plexconn" value="${s.index}|${esc(c.url)}" ${c.local ? 'checked' : ''}> ${esc(c.url)} ${c.local ? '<span class="chip">local</span>' : ''}</label>`).join('')}
    </div>`).join('')}
    <button class="btn primary" id="plex-use">Use this server</button></div>`;
  if (!box.querySelector('input:checked')) box.querySelector('input')?.click();
  $('#plex-use').onclick = guard(async () => {
    const [serverIndex, url] = box.querySelector('input:checked').value.split('|');
    const res = await api('POST', '/api/plex/settings', { serverIndex: +serverIndex, url });
    toast(res.status.connected ? 'Connected to Plex!' : `Saved, but can't reach server: ${res.status.lastError}`, !res.status.connected);
    await refresh();
  });
}

// ---------- account ----------
async function openAccount() {
  const { user, users } = await api('GET', '/api/auth/me');
  const dlg = $('#editor');
  dlg.innerHTML = `
    <div class="dlg-head"><h2>👤 ${esc(user)}</h2><button class="btn" id="sign-out">Sign out</button></div>
    <div class="dlg-body">
      <div class="block">
        <div class="section-label">Change your password</div>
        <div class="fields"><label class="field grow">New password<input type="password" id="pw-new" autocomplete="new-password"></label><button class="btn" id="pw-save">Change</button></div>
      </div>
      <div class="block">
        <div class="section-label">People who can sign in</div>
        ${users.map((u) => `<div class="row spread small" style="padding:4px 0"><span>${esc(u)}${u === user ? ' <span class="chip">you</span>' : ''}</span>${u === user ? '' : `<button class="btn sm ghost danger" data-deluser="${esc(u)}">Remove</button>`}</div>`).join('')}
        <div class="fields" style="margin-top:10px">
          <label class="field">Username<input type="text" id="nu-name"></label>
          <label class="field">Password<input type="password" id="nu-pw" autocomplete="new-password"></label>
          <button class="btn" id="nu-add">Add person</button>
        </div>
      </div>
    </div>
    <div class="dlg-foot"><span></span><button class="btn" id="acct-close">Close</button></div>`;
  dlg.showModal();
  $('#acct-close').onclick = () => dlg.close();
  $('#sign-out').onclick = guard(async () => {
    await api('POST', '/api/auth/logout');
    location.href = '/login.html';
  });
  $('#pw-save').onclick = guard(async () => {
    await api('POST', '/api/auth/password', { password: $('#pw-new').value });
    $('#pw-new').value = '';
    toast('Password changed');
  });
  $('#nu-add').onclick = guard(async () => {
    await api('POST', '/api/auth/users', { username: $('#nu-name').value, password: $('#nu-pw').value });
    toast('Added');
    openAccount();
  });
  dlg.querySelectorAll('[data-deluser]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm(`Remove ${b.dataset.deluser}?`)) return;
    await api('POST', '/api/auth/users/delete', { username: b.dataset.deluser });
    openAccount();
  })));
}

// ---------- activity ----------
function logLine(e) {
  return `<div class="${e.level}"><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>${esc(e.message)}</span></div>`;
}

function renderActivity() {
  const el = $('#tab-activity');
  if (el.dataset.ready) return;
  el.dataset.ready = '1';
  el.innerHTML = `
    <div class="card stack" style="margin-bottom:16px">
      <div><h2>Test without Plex</h2><p class="sub" style="margin:0">Pretend a Plex event happened and watch your workflows respond.</p></div>
      <div class="fields">
        <label class="field">Event<select id="sim-event">${EVENTS.plex.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <label class="field grow">Player name<input type="text" id="sim-player" value="Living Room TV"></label>
        <label class="field">Media<select id="sim-media">${MEDIA_TYPES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
        <button class="btn primary" id="sim-go">Fire event</button>
      </div>
    </div>
    <div class="card">
      <div class="row spread"><h2>Live activity</h2><button class="btn sm ghost" id="log-clear">Clear view</button></div>
      <div class="log" id="log"></div>
    </div>`;
  $('#sim-go').onclick = guard(async () => {
    await api('POST', '/api/simulate', { type: $('#sim-event').value, player: $('#sim-player').value, mediaType: $('#sim-media').value, title: 'Simulated' });
  });
  $('#log-clear').onclick = () => ($('#log').innerHTML = '');
  api('GET', '/api/log').then((entries) => {
    $('#log').innerHTML = entries.slice().reverse().map(logLine).join('');
  });
  const es = new EventSource('/api/log/stream');
  es.onmessage = (m) => $('#log').insertAdjacentHTML('afterbegin', logLine(JSON.parse(m.data)));
}

// ---------- boot ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  try {
    localStorage.setItem('playlite.tab', name);
  } catch {
    // storage unavailable
  }
  if (name === 'lights') refreshLights().catch((e) => toast(e.message, true));
  if (name === 'network') refreshNetwork().catch((e) => toast(e.message, true));
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

await refresh().catch((e) => toast(e.message, true));
refreshLights().catch(() => {});
refreshNetwork().catch(() => {});
let saved = null;
try {
  saved = localStorage.getItem('playlite.tab');
} catch {
  // storage unavailable
}
if (saved && saved !== 'routines' && document.getElementById(`tab-${saved}`)) showTab(saved);

setInterval(() => api('GET', '/api/state').then((s) => {
  const waitingChanged = JSON.stringify(s.waiting) !== JSON.stringify(S.state.waiting);
  Object.assign(S.state, { mode: s.mode, modes: s.modes, waiting: s.waiting, scenes: s.scenes, mqtt: s.mqtt, plex: s.plex, hue: s.hue, govee: s.govee, homeassistant: s.homeassistant, alexa: s.alexa, ai: s.ai, network: s.network, sky: s.sky });
  renderHeader();
  if (waitingChanged && !$('#idea')?.value) renderRoutines(); // don't wipe an idea being typed
}).catch(() => {}), 10_000);
setInterval(() => {
  if ($('#tab-network').classList.contains('active')) refreshNetwork().catch(() => {});
}, 30_000);
