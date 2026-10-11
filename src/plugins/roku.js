// Roku: the "📺 Roku remote" step (remote buttons, open a channel) over the local ECP API. Rokus come from network discovery.
import { Roku, ROKU_KEYS } from '../integrations/roku.js';
import { template } from '../util.js';

export default {
  id: 'roku',
  name: 'Roku',
  create: ({ discovery, log }) => new Roku({ discovery, log }),

  steps: {
    roku: {
      label: () => 'Roku',
      validate(s) {
        if (!s.app && !ROKU_KEYS.some(([k]) => k === s.key)) throw new Error(`roku step needs "key" (${ROKU_KEYS.map(([k]) => k).join(', ')}) or "app"`);
      },
      async run(step, event, { service: roku, log }) {
        if (!roku) throw new Error('Roku control is not available');
        const device = template(step.device ?? '', event);
        if (step.app) await roku.launch(device, step.app);
        else await roku.keypress(device, step.key ?? 'Play');
        log.info(`Roku${device ? ` ${device}` : ''}: ${step.app ? `open ${step.app}` : step.key}`);
      },
    },
  },

  guide: {
    steps: `- {"type":"roku","device":"Bedroom Roku","key":"Play"} or {"type":"roku","device":"…","app":"plex"}   (Roku remote buttons: Play (= play/pause), Home,
  Back, Select, Rev, Fwd, InstantReplay, VolumeUp, VolumeDown, VolumeMute, PowerOff, PowerOn; apps: plex, netflix, youtube, disney+, hulu, prime video, max, spotify)`,
  },

  tools: (roku) => [
    {
      name: 'roku',
      description: 'Press a Roku remote button (key) or open a channel (app) on a Roku found on the network. Omit device if there is only one Roku.',
      inputSchema: { type: 'object', properties: { device: { type: 'string' }, key: { type: 'string', enum: ROKU_KEYS.map(([k]) => k) }, app: { type: 'string' } }, additionalProperties: false },
      run: async (a) => {
        if (!roku) throw new Error('Roku control is not available');
        if (a.app) await roku.launch(a.device, a.app);
        else await roku.keypress(a.device, a.key ?? 'Play');
        return { ok: true, devices: roku.devices().map((d) => d.name) };
      },
    },
  ],

  state: (roku) => ({ rokus: roku?.devices() ?? [] }),
};
