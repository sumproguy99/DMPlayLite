// Web Push with no dependencies: VAPID signing (RFC 8292) and payload encryption (RFC 8291, aes128gcm / RFC 8188).
// The browser gives us a subscription { endpoint, keys: { p256dh, auth } }; we POST an encrypted message to the endpoint
// (Google / Mozilla / Apple push service), signed with our VAPID key so the push service knows it's us.
import crypto from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(String(str), 'base64url'),
};

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// A new VAPID key pair: { publicKey: base64url raw P-256 point (the browser's applicationServerKey), privateKey: JWK }
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u.enc(publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)), privateKey: jwk };
}

// Authorization header value for one push service origin.
export function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateKey, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

// Encrypt a payload for one subscription. salt / server key can be passed in for the RFC 8291 test vector.
export function encrypt(payload, keys, { salt = crypto.randomBytes(16), serverKey = null } = {}) {
  const uaPublic = b64u.dec(keys.p256dh);
  const authSecret = b64u.dec(keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKey) ecdh.setPrivateKey(b64u.dec(serverKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  // RFC 8291 §3.4: combine the shared secret with the browser's auth secret, then derive the content key and nonce
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]); // 0x02 = last record
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Send one message. Resolves { status }; 404 / 410 mean the subscription is gone (app removed, permission revoked).
export async function sendPush(subscription, payload, { vapid, subject, ttl = 24 * 3600, urgency = 'normal', timeoutMs = 10_000 }) {
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body: encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), subscription.keys),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, error: text };
}
