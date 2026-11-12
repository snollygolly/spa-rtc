// Binary packets for the `fast` channel: a growable writer and a bounds-checked reader over a
// DataView, the quantizers games share, sequence numbers that wrap, and a delta codec for a set of
// entities (only what changed since a baseline the other side has: Quake 3's delta entities).
const TAU = Math.PI * 2;

// A number rounded into lo…hi (never -0, so states compare equal after a round trip).
export const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : 0))) || 0;
// An angle (radians, any range) in 16 bits: a full turn is 65536.
export const angleToU16 = a => Math.round((((((Number.isFinite(a) ? a : 0) % TAU) + TAU) % TAU) / TAU) * 65536) & 0xffff;
export const u16ToAngle = n => (n / 65536) * TAU;
// A number times `scale`, rounded into a signed 16-bit range (and back).
export const toI16 = (v, scale = 1) => clampInt(v * scale, -32768, 32767);
export const fromI16 = (n, scale = 1) => n / scale;
// -1…1 in a signed byte.
export const toI8Unit = v => clampInt(v * 127, -127, 127);
export const fromI8Unit = n => n / 127;

// Is sequence number `a` newer than `b`, where both wrap at 2^bits?
export function seqNewer(a, b, bits = 16) {
	const mod = 2 ** bits;
	const d = (((a - b) % mod) + mod) % mod;
	return d !== 0 && d < mod / 2;
}

const SIZES = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 };
const SETTERS = { u8: "setUint8", i8: "setInt8", u16: "setUint16", i16: "setInt16", u32: "setUint32", i32: "setInt32", f32: "setFloat32", f64: "setFloat64" };
const GETTERS = { u8: "getUint8", i8: "getInt8", u16: "getUint16", i16: "getInt16", u32: "getUint32", i32: "getInt32", f32: "getFloat32", f64: "getFloat64" };

export class Writer {
	constructor(size = 256) {
		this.view = new DataView(new ArrayBuffer(Math.max(1, size)));
		this.at = 0;
	}

	room(n) {
		if (this.at + n <= this.view.byteLength) return;
		const bigger = new DataView(new ArrayBuffer(Math.max(this.view.byteLength * 2, this.at + n)));
		new Uint8Array(bigger.buffer).set(new Uint8Array(this.view.buffer, 0, this.at));
		this.view = bigger;
	}

	// Writes `v` as wire type `type` (u8, i8, u16, i16, u32, i32, f32, f64).
	put(type, v) {
		const size = SIZES[type];
		if (!size) throw new TypeError(`unknown wire type ${type}`);
		this.room(size);
		this.view[SETTERS[type]](this.at, v);
		this.at += size;
	}

	u8(v) {
		this.put("u8", v);
	}

	i8(v) {
		this.put("i8", v);
	}

	u16(v) {
		this.put("u16", v);
	}

	i16(v) {
		this.put("i16", v);
	}

	u32(v) {
		this.put("u32", v);
	}

	i32(v) {
		this.put("i32", v);
	}

	f32(v) {
		this.put("f32", v);
	}

	f64(v) {
		this.put("f64", v);
	}

	// A short UTF-8 string, length first (u8, so at most 255 bytes).
	str(text) {
		const bytes = new TextEncoder().encode(String(text ?? "")).slice(0, 255);
		this.u8(bytes.length);
		this.room(bytes.length);
		new Uint8Array(this.view.buffer, this.at, bytes.length).set(bytes);
		this.at += bytes.length;
	}

	// The bytes written, as an ArrayBuffer of exactly that length.
	done() {
		return this.view.buffer.slice(0, this.at);
	}
}

// ArrayBuffer, typed array or DataView in; anything else (strings, blobs) throws a TypeError,
// which decoders catch like a short packet.
function viewOf(data) {
	if (data instanceof ArrayBuffer) return new DataView(data);
	if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
	throw new TypeError("not binary");
}

export class Reader {
	constructor(data) {
		this.view = viewOf(data);
		this.at = 0;
	}

	get left() {
		return this.view.byteLength - this.at;
	}

	// Reads one value of wire type `type`; past the end it throws a RangeError ("short packet").
	get(type) {
		const size = SIZES[type];
		if (!size) throw new TypeError(`unknown wire type ${type}`);
		if (this.at + size > this.view.byteLength) throw new RangeError("short packet");
		const v = this.view[GETTERS[type]](this.at);
		this.at += size;
		return v;
	}

	u8() {
		return this.get("u8");
	}

	i8() {
		return this.get("i8");
	}

	u16() {
		return this.get("u16");
	}

	i16() {
		return this.get("i16");
	}

	u32() {
		return this.get("u32");
	}

	i32() {
		return this.get("i32");
	}

	f32() {
		return this.get("f32");
	}

	f64() {
		return this.get("f64");
	}

	str() {
		const n = this.u8();
		if (this.at + n > this.view.byteLength) throw new RangeError("short packet");
		const text = new TextDecoder().decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, n));
		this.at += n;
		return text;
	}
}

// Runs `fn(reader)` over `data` and returns what it returns, or null for a short, junk or
// non-binary packet (anything `fn` throws).
export function decode(data, fn) {
	try {
		return fn(new Reader(data));
	} catch {
		return null;
	}
}

// A delta codec for a set of entities, each a flat object of already-quantized numbers.
//   fields: [{keys: ["px", "py", "pz"], type: "i16"}, {keys: ["yaw"], type: "u16"}, …], in order;
//     each group of keys is one bit of the change mask, sent when any key in it changed.
//   kind / id: the wire types of the two keys that name an entity (`kind` and `id`).
//   blank(kind, id): a new entity's values before its first fields are read.
// write(w, ents, base) sends the entities that are new or changed against `base` (a Map from an
// earlier state the other side has, or null for everything) and the keys of those gone since;
// read(r, base) gives back the full Map. Entity keys are `${kind}:${id}` (keyOf).
export const keyOf = (kind, id) => `${kind}:${id}`;

export function entityCodec(fields, { kind = "u8", id = "u16", blank = (k, i) => ({ kind: k, id: i }) } = {}) {
	if (fields.length > 32) throw new RangeError("at most 32 field groups");
	let maskType = "u32";
	if (fields.length <= 8) maskType = "u8";
	else if (fields.length <= 16) maskType = "u16";
	const groups = fields.map((f, i) => ({ ...f, bit: 2 ** i }));
	const all = 2 ** fields.length - 1;

	function maskOf(e, old) {
		if (!old) return all;
		let mask = 0;
		for (const g of groups) if (g.keys.some(key => e[key] !== old[key])) mask += g.bit;
		return mask;
	}

	return {
		write(w, ents, base = null) {
			const changed = [];
			for (const [k, e] of ents) {
				const mask = maskOf(e, base ? base.get(k) : null);
				if (mask) changed.push([e, mask]);
			}
			const removed = base ? [...base].filter(([k]) => !ents.has(k)).map(([, e]) => e) : [];
			if (changed.length > 0xffff || removed.length > 0xffff) throw new RangeError("too many entities");
			w.u16(changed.length);
			for (const [e, mask] of changed) {
				w.put(kind, e.kind);
				w.put(id, e.id);
				w.put(maskType, mask);
				for (const g of groups) if (mask & g.bit) for (const key of g.keys) w.put(g.type, e[key]);
			}
			w.u16(removed.length);
			for (const e of removed) {
				w.put(kind, e.kind);
				w.put(id, e.id);
			}
		},
		read(r, base = null) {
			const ents = new Map();
			if (base) for (const [k, e] of base) ents.set(k, { ...e });
			const count = r.u16();
			for (let i = 0; i < count; i++) {
				const ek = r.get(kind);
				const eid = r.get(id);
				const mask = r.get(maskType);
				const k = keyOf(ek, eid);
				const e = ents.get(k) || { ...blank(ek, eid), kind: ek, id: eid };
				for (const g of groups) if (mask & g.bit) for (const key of g.keys) e[key] = r.get(g.type);
				ents.set(k, e);
			}
			const gone = r.u16();
			for (let i = 0; i < gone; i++) ents.delete(keyOf(r.get(kind), r.get(id)));
			return ents;
		}
	};
}
