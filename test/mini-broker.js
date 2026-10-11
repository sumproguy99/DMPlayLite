// A tiny MQTT 3.1.1 broker for tests: auth, subscribe, retained messages, fan-out, QoS 1 delivery.
import net from 'node:net';
import { packet, parsePackets, decodePublish, topicMatches } from '../src/integrations/mqtt.js';

const readStr = (b, off) => {
  const len = b.readUInt16BE(off);
  return [b.subarray(off + 2, off + 2 + len).toString('utf8'), off + 2 + len];
};

const publish = (topic, payload, { qos = 0, retain = false, id = 1 } = {}) => {
  const t = Buffer.from(topic);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(t.length);
  const pid = Buffer.alloc(qos ? 2 : 0);
  if (qos) pid.writeUInt16BE(id);
  return packet(3, (qos << 1) | (retain ? 1 : 0), Buffer.concat([head, t, pid, Buffer.from(payload)]));
};

export function startBroker({ username, password, qos = 0 } = {}) {
  const clients = new Set();
  const retained = new Map();
  const received = []; // { topic, payload, retain } published by clients
  const acks = [];
  let nextId = 1;
  const deliver = (c, topic, payload, retain = false) => {
    if (c.subs.some((s) => topicMatches(s, topic))) c.sock.write(publish(topic, payload, { qos, retain, id: nextId++ }));
  };
  const server = net.createServer((sock) => {
    const c = { sock, subs: [], buf: Buffer.alloc(0) };
    clients.add(c);
    sock.on('close', () => clients.delete(c));
    sock.on('error', () => {});
    sock.on('data', (d) => {
      const { packets, rest } = parsePackets(Buffer.concat([c.buf, d]));
      c.buf = Buffer.from(rest);
      for (const p of packets) {
        if (p.type === 1) {
          const flags = p.body[7];
          let off = 10;
          let id, user, pass;
          [id, off] = readStr(p.body, off);
          if (flags & 0x80) [user, off] = readStr(p.body, off);
          if (flags & 0x40) [pass, off] = readStr(p.body, off);
          c.id = id;
          const ok = !username || (user === username && pass === password);
          sock.write(packet(2, 0, Buffer.from([0, ok ? 0 : 4])));
          if (!ok) sock.end();
        } else if (p.type === 8) {
          let off = 2;
          while (off < p.body.length) {
            let t;
            [t, off] = readStr(p.body, off);
            off += 1;
            c.subs.push(t);
          }
          sock.write(packet(9, 0, Buffer.concat([p.body.subarray(0, 2), Buffer.from([1])])));
          for (const [topic, payload] of retained) deliver(c, topic, payload, true);
        } else if (p.type === 3) {
          const m = decodePublish(p);
          received.push(m);
          if (m.retain) retained.set(m.topic, m.payload);
          for (const other of clients) deliver(other, m.topic, m.payload);
        } else if (p.type === 4) {
          acks.push(p.body.readUInt16BE(0));
        } else if (p.type === 12) {
          sock.write(packet(13, 0));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    received,
    acks,
    retained,
    clients,
    // publish as if from another device on the broker
    send(topic, payload, { retain = false } = {}) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (retain) retained.set(topic, text);
      for (const c of clients) deliver(c, topic, text);
    },
    close() {
      for (const c of clients) c.sock.destroy();
      return new Promise((r) => server.close(r));
    },
  })));
}
