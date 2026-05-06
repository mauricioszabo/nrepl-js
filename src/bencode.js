// Minimal bencode encoder/decoder for nREPL.
//
// Decoded shapes:
//   integer  -> Number (safe for nREPL ids; bigints would break clients)
//   bytes    -> string by default, decoded as UTF-8
//   list     -> Array
//   dict     -> plain object with string keys (sorted on encode per spec)
//
// Encoder accepts: number, string, Buffer, Array, plain object.

const COLON = 0x3a; // :
const E     = 0x65; // e
const I     = 0x69; // i
const L     = 0x6c; // l
const D     = 0x64; // d
const ZERO  = 0x30; // 0
const NINE  = 0x39; // 9
const MINUS = 0x2d; // -

export function encode(value) {
  const parts = [];
  enc(value, parts);
  return Buffer.concat(parts);
}

function enc(v, out) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeError('bencode: only integers, got ' + v);
    out.push(Buffer.from('i' + v + 'e'));
    return;
  }
  if (typeof v === 'string') {
    const buf = Buffer.from(v, 'utf8');
    out.push(Buffer.from(buf.length + ':'));
    out.push(buf);
    return;
  }
  if (Buffer.isBuffer(v)) {
    out.push(Buffer.from(v.length + ':'));
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    out.push(Buffer.from('l'));
    for (const item of v) enc(item, out);
    out.push(Buffer.from('e'));
    return;
  }
  if (v && typeof v === 'object') {
    out.push(Buffer.from('d'));
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    for (const k of keys) {
      enc(k, out);
      enc(v[k], out);
    }
    out.push(Buffer.from('e'));
    return;
  }
  throw new TypeError('bencode: unsupported value: ' + Object.prototype.toString.call(v));
}

// Returns { value, rest } if a complete value was decoded, or null if more bytes are needed.
// Throws on syntactically invalid input.
export function decode(buf) {
  try {
    const [value, offset] = dec(buf, 0);
    return { value, rest: buf.subarray(offset) };
  } catch (e) {
    if (e && e.code === 'NEED_MORE') return null;
    throw e;
  }
}

function need(buf, offset, n) {
  if (offset + n > buf.length) {
    const e = new Error('need more bytes');
    e.code = 'NEED_MORE';
    throw e;
  }
}

function dec(buf, offset) {
  need(buf, offset, 1);
  const b = buf[offset];
  if (b === I) return decInt(buf, offset);
  if (b === L) return decList(buf, offset);
  if (b === D) return decDict(buf, offset);
  if (b >= ZERO && b <= NINE) return decBytes(buf, offset);
  throw new Error('bencode: unexpected byte 0x' + b.toString(16) + ' at ' + offset);
}

function decInt(buf, offset) {
  let i = offset + 1;
  let neg = false;
  need(buf, i, 1);
  if (buf[i] === MINUS) { neg = true; i++; }
  let n = 0;
  let any = false;
  for (; ; i++) {
    need(buf, i, 1);
    const b = buf[i];
    if (b === E) break;
    if (b < ZERO || b > NINE) throw new Error('bencode: bad int digit at ' + i);
    n = n * 10 + (b - ZERO);
    any = true;
  }
  if (!any) throw new Error('bencode: empty int');
  return [neg ? -n : n, i + 1];
}

function decBytes(buf, offset) {
  let i = offset;
  let len = 0;
  for (; ; i++) {
    need(buf, i, 1);
    const b = buf[i];
    if (b === COLON) break;
    if (b < ZERO || b > NINE) throw new Error('bencode: bad length digit at ' + i);
    len = len * 10 + (b - ZERO);
  }
  const start = i + 1;
  need(buf, start, len);
  return [buf.subarray(start, start + len).toString('utf8'), start + len];
}

function decList(buf, offset) {
  let i = offset + 1;
  const out = [];
  for (;;) {
    need(buf, i, 1);
    if (buf[i] === E) return [out, i + 1];
    const [v, ni] = dec(buf, i);
    out.push(v);
    i = ni;
  }
}

function decDict(buf, offset) {
  let i = offset + 1;
  const out = {};
  for (;;) {
    need(buf, i, 1);
    if (buf[i] === E) return [out, i + 1];
    const [k, ki] = decBytes(buf, i);
    const [v, vi] = dec(buf, ki);
    out[k] = v;
    i = vi;
  }
}
