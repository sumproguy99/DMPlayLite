// Minimal DNS wire-format codec — just enough for mDNS service discovery.

export const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodeQuery(names, type = TYPE.PTR) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((n) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // class IN
    return Buffer.concat([encodeName(n), tail]);
  });
  return Buffer.concat([header, ...questions]);
}

function readName(buf, offset) {
  const labels = [];
  let off = offset;
  let end = -1;
  for (let hops = 0; hops < 64; hops++) {
    const len = buf[off];
    if (len === undefined) throw new Error('truncated name');
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += len + 1;
  }
  return { name: labels.join('.'), end: end >= 0 ? end : off };
}

export function decodePacket(buf) {
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;
  const records = [];
  for (let i = 0; i < total && off < buf.length; i++) {
    const { name, end } = readName(buf, off);
    off = end;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    off = rd + rdlen;
    let data;
    if (type === TYPE.PTR) data = readName(buf, rd).name;
    else if (type === TYPE.SRV) data = { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name };
    else if (type === TYPE.A) data = [...buf.subarray(rd, rd + 4)].join('.');
    else if (type === TYPE.TXT) {
      data = {};
      for (let p = rd; p < rd + rdlen; ) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, p + 1 + l);
        p += 1 + l;
        if (!s) continue;
        const eq = s.indexOf('=');
        data[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? true : s.slice(eq + 1);
      }
    } else continue;
    records.push({ name, type, data });
  }
  return { response: (flags & 0x8000) !== 0, records };
}
