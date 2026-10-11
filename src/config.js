import fs from 'node:fs';
import path from 'node:path';
import { randomId } from './util.js';

const DATA_DIR = process.env.PLAYLITE_DATA ?? path.resolve('data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const VIDEO = ['movie', 'episode', 'clip'];

// Starter routines matching the original idea. Edit them in the UI.
function seedRoutines() {
  return [
    {
      id: randomId(4),
      name: 'Plex opens on Living Room TV → pulse basement 5×',
      enabled: true,
      voiceName: 'Movie Alert',
      trigger: { source: 'plex', event: 'player.online', player: 'Living Room' },
      cooldownSec: 120,
      targets: ['group:basement'],
      steps: [{ type: 'pulse', levels: [100, 70, 100], times: 5, stepMs: 1000, restore: true }],
    },
    {
      id: randomId(4),
      name: 'Video starts → natural light 100%, fade to 10%',
      enabled: true,
      trigger: { source: 'plex', event: 'media.play', player: 'Living Room', mediaTypes: VIDEO, skipContinued: true },
      targets: ['group:living-room'],
      steps: [
        { type: 'set', brightness: 100, kelvin: 4000, transitionMs: 1000 },
        { type: 'wait', ms: 1500 },
        { type: 'set', brightness: 10, transitionMs: 10000 },
      ],
    },
    {
      id: randomId(4),
      name: 'Paused → slowly up to 70%',
      enabled: true,
      trigger: { source: 'plex', event: 'media.pause', player: 'Living Room', mediaTypes: VIDEO },
      targets: ['group:living-room'],
      steps: [{ type: 'set', brightness: 70, transitionMs: 5000 }],
    },
    {
      id: randomId(4),
      name: 'Play pressed → slowly dim to 10%',
      enabled: true,
      trigger: { source: 'plex', event: 'media.resume', player: 'Living Room', mediaTypes: VIDEO },
      targets: ['group:living-room'],
      steps: [{ type: 'set', brightness: 10, transitionMs: 4000 }],
    },
    {
      id: randomId(4),
      name: 'Stopped → back to 100% natural',
      enabled: false,
      trigger: { source: 'plex', event: 'media.stop', player: 'Living Room', mediaTypes: VIDEO },
      targets: ['group:living-room'],
      steps: [{ type: 'set', brightness: 100, kelvin: 4000, transitionMs: 4000 }],
    },
  ];
}

function defaults() {
  return {
    webhookKey: randomId(12),
    plex: { url: '', token: '', clientId: `playlite-${randomId(8)}`, pollSeconds: 10 },
    hue: { bridgeIp: '', username: '' },
    govee: { devices: {}, multicastInterface: '' },
    homeassistant: { url: '', token: '' },
    alexa: { enabled: true, port: 80, ids: {}, hidden: [] },
    ai: { apiKey: '', model: '' },
    location: { lat: null, lon: null, name: '' },
    groups: [
      { id: 'living-room', name: 'Living Room', members: [] },
      { id: 'basement', name: 'Basement', members: [] },
    ],
    routines: seedRoutines(),
  };
}

let current;

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const base = defaults();
    current = { ...base, ...stored };
    for (const key of ['plex', 'hue', 'govee', 'homeassistant', 'alexa', 'ai', 'location']) {
      current[key] = { ...base[key], ...stored[key] };
    }
  } else {
    current = defaults();
  }
  saveConfig();
  return current;
}

export const getConfig = () => current;

export function saveConfig() {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

export function updateConfig(mutator) {
  mutator(current);
  saveConfig();
  return current;
}

export { CONFIG_PATH, DATA_DIR };
