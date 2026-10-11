// Playlite app notifications: phones / browsers that installed Playlite and allowed notifications get every "📲 Phone alert"
// as a real push notification (Web Push), alongside ntfy. Browsers only allow this on a secure address (HTTPS — e.g.
// `tailscale serve`, Caddy, Nginx Proxy Manager — or localhost); on iPhone, Playlite must be added to the Home Screen first.
import { generateVapidKeys, sendPush } from '../webpush.js';
import { HttpError, readJson } from '../http-utils.js';
import { randomId } from '../util.js';
import crypto from 'node:crypto';

// lets a browser tell whether Playlite still has its subscription, without sending the push address around
export const endpointHash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

// Who we are to the push services (Apple insists on a mailto: or https: subject).
const SUBJECT = 'https://github.com/sumproguy99/DMPlayLite';

class PushService {
  constructor({ getConfig, updateConfig, log }) {
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.log = log;
  }

  get cfg() { return this.getConfig().push ?? {}; }
  get devices() { return this.cfg.subscriptions ?? []; }
  get ready() { return this.devices.length > 0; }

  // VAPID keys are made once and kept: changing them would cut off every subscribed device.
  get vapid() {
    if (!this.cfg.vapid?.publicKey) this.updateConfig((c) => (c.push = { ...c.push, vapid: generateVapidKeys() }));
    return this.cfg.vapid;
  }

  subscribe(subscription, { device, user }) {
    if (!/^https:\/\//.test(subscription?.endpoint ?? '') || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('Not a valid push subscription');
    const entry = { id: randomId(4), endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, device: String(device || 'Browser').slice(0, 60), user, since: new Date().toISOString() };
    this.updateConfig((c) => {
      const list = (c.push.subscriptions ?? []).filter((s) => s.endpoint !== entry.endpoint); // same browser again: replace
      c.push = { ...c.push, subscriptions: [...list, entry] };
    });
    return entry;
  }

  remove(q) {
    const before = this.devices.length;
    this.updateConfig((c) => (c.push = { ...c.push, subscriptions: (c.push.subscriptions ?? []).filter((s) => s.id !== q && s.endpoint !== q) }));
    return before !== this.devices.length;
  }

  // Send to every device; drop the ones the push service says are gone. Resolves the number delivered.
  async sendAll(msg) {
    const vapid = this.vapid;
    const results = await Promise.all(this.devices.map(async (s) => {
      try {
        const r = await sendPush(s, msg, { vapid, subject: SUBJECT, urgency: msg.priority >= 4 ? 'high' : 'normal' });
        if (r.gone) {
          this.remove(s.id);
          this.log.info(`App notifications: ${s.device} unsubscribed — removed`);
        } else if (!r.ok) this.log.warn(`App notification to ${s.device}: HTTP ${r.status} ${r.error}`);
        return r.ok;
      } catch (err) {
        this.log.warn(`App notification to ${s.device}: ${err.cause?.code ?? err.message}`);
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }
}

export default {
  id: 'push',
  name: 'Playlite app',
  config: { vapid: null, subscriptions: [] },
  create: (ctx) => new PushService(ctx),

  // the engine sends every phone alert here too
  notifier: {
    ready: (push) => push.ready,
    async send(push, msg) {
      if (!push.ready) return 0;
      return push.sendAll(msg);
    },
  },

  state: (push) => ({ push: { devices: push.devices.map(({ id, device, user, since, endpoint }) => ({ id, device, user, since, hash: endpointHash(endpoint) })) } }),

  routes: (push) => ({
    'GET /api/push/key': () => ({ publicKey: push.vapid.publicKey }),
    'POST /api/push/subscribe': async (req, url, user) => {
      const { subscription, device } = await readJson(req);
      try {
        return { ok: true, id: push.subscribe(subscription, { device, user }).id };
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
    'POST /api/push/unsubscribe': async (req) => {
      const { id, endpoint } = await readJson(req);
      return { ok: push.remove(id ?? endpoint) };
    },
    'POST /api/push/test': async () => {
      if (!push.ready) throw new HttpError(400, 'No device has turned on app notifications yet');
      const sent = await push.sendAll({ title: 'Playlite', message: 'Test alert — app notifications are working 🎉', priority: 3 });
      if (!sent) throw new HttpError(400, 'No device accepted the notification — see Activity for why');
      return { ok: true, sent };
    },
  }),
};
