"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const load = async() => ({
	lerp: await import("../src/lerp.js"),
	snap: await import("../src/snapbuf.js"),
	bytes: await import("../src/bytes.js"),
	predict: await import("../src/predict.js"),
	server: await import("../src/server.js"),
	client: await import("../src/client.js"),
	lag: await import("../src/lagcomp.js"),
	code: await import("../src/code.js")
});

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("poses blend: numbers and points interpolate, angles the short way, the rest from the nearer", async() => {
	const { lerp } = await load();
	near(lerp.lerp(2, 4, 0.25), 2.5);
	near(lerp.lerpAngle(3, -3, 0.5), Math.PI, 1e-6);
	near(lerp.lerpAngle(-3, 3, 0.5), -Math.PI, 1e-6);
	assert.deepStrictEqual(lerp.lerpVec({ x: 0, y: 0, z: 0 }, { x: 2, y: 4, z: 6 }, 0.5), { x: 1, y: 2, z: 3 });
	assert.deepStrictEqual(lerp.lerpVec({ x: 0, z: 0 }, { x: 2, z: 6 }, 0.5), { x: 1, z: 3 });
	const a = { pos: { x: 0, y: 0, z: 0 }, yaw: 3, pitch: 0, alive: true, weapon: "rifle", n: 0, tag: null };
	const b = { pos: { x: 2, y: 0, z: 2 }, yaw: -3, pitch: 1, alive: false, weapon: "pistol", n: 10, extra: 1 };
	const mid = lerp.blendPose(a, b, 0.25, { snap: ["n"] });
	assert.deepStrictEqual(mid.pos, { x: 0.5, y: 0, z: 0.5 });
	near(mid.pitch, 0.25);
	assert.ok(Math.abs(mid.yaw) > 3, "across the back, not through zero");
	assert.strictEqual(mid.alive, true);
	assert.strictEqual(mid.weapon, "rifle");
	assert.strictEqual(mid.n, 0, "snapped keys aren't blended");
	assert.strictEqual(mid.tag, null);
	const late = lerp.blendPose(a, b, 0.75);
	assert.strictEqual(late.alive, false);
	assert.strictEqual(late.extra, 1, "a key only one side has comes as it is");
	near(late.n, 7.5);
	assert.ok(Number.isNaN(lerp.blendPose({ v: NaN }, { v: 1 }, 0.25).v), "not a number: the nearer, unblended");
});

test("the host clock estimate eases toward samples, and resets when far off", async() => {
	const { snap } = await load();
	const clock = snap.createClock();
	assert.strictEqual(snap.serverNow(clock, 5), 0, "nothing known yet");
	snap.clockSample(clock, 10, 1);
	near(snap.serverNow(clock, 2), 11);
	snap.clockSample(clock, 11.05, 2);
	near(clock.offset, 9 + 0.05 * snap.CLOCK_PULL);
	snap.clockSample(clock, 100, 3);
	near(clock.offset, 97);
	near(snap.renderTime(clock, 3), 100 - snap.INTERP);
	assert.strictEqual(snap.renderTime(snap.createClock(), 3), 0);
});

test("others are interpolated between snapshots, carried on briefly, then held", async() => {
	const { snap } = await load();
	const buf = snap.createBuffer({ keep: 3 });
	assert.deepStrictEqual(snap.sample(buf, 1), []);
	const ent = x => ({ id: 1, pos: { x, y: 0, z: 0 }, yaw: 0 });
	snap.pushFrame(buf, 1, new Map([["a", ent(0)]]));
	assert.deepStrictEqual(snap.sample(buf, 5), [ent(0)], "one frame: as it is");
	snap.pushFrame(buf, 1.1, new Map([["a", ent(1)], ["b", ent(5)]]));
	near(snap.sample(buf, 1.05)[0].pos.x, 0.5);
	assert.deepStrictEqual(snap.sample(buf, 1.05)[1], ent(5), "new in the later frame: as it is there");
	near(snap.sample(buf, 0)[0].pos.x, 0, 1e-9);
	near(snap.sample(buf, 1.12)[0].pos.x, 1.2, 1e-9);
	near(snap.sample(buf, 9)[0].pos.x, 1 + snap.EXTRAPOLATE / 0.1, 1e-9);
	// Gone from the newer frame: kept until the newer frame's time.
	snap.pushFrame(buf, 1.2, new Map([["b", ent(5)]]));
	assert.strictEqual(snap.sample(buf, 1.15).length, 2);
	assert.strictEqual(snap.sample(buf, 1.2).length, 1);
	// A late duplicate is ignored; time going far back is a new round.
	snap.pushFrame(buf, 1.15, new Map());
	assert.strictEqual(buf.frames.length, 3);
	snap.pushFrame(buf, 1.3, new Map());
	assert.strictEqual(buf.frames.length, 3, "only `keep` kept");
	snap.pushFrame(buf, 0.1, new Map([["c", ent(9)]]));
	assert.strictEqual(buf.frames.length, 1);
	// Custom pose and blend.
	const raw = snap.createBuffer();
	snap.pushFrame(raw, 0, new Map([["a", { px: 0 }]]));
	snap.pushFrame(raw, 1, new Map([["a", { px: 32 }]]));
	const out = snap.sample(raw, 0.5, { pose: e => ({ x: e.px / 32 }), blend: (p, q, f) => ({ x: p.x + (q.x - p.x) * f, blended: true }) });
	assert.deepStrictEqual(out, [{ x: 0.5, blended: true }]);
	// Two frames at the same time (span 0): the newer.
	const flat = snap.createBuffer();
	flat.frames.push({ time: 1, ents: new Map([["a", ent(0)]]) }, { time: 1, ents: new Map([["a", ent(3)]]) });
	assert.strictEqual(snap.sample(flat, 1)[0].pos.x, 3);
});

test("bytes: everything written reads back, short or junk packets are refused", async() => {
	const { bytes } = await load();
	const w = new bytes.Writer(1);
	w.u8(255);
	w.i8(-128);
	w.u16(65535);
	w.i16(-32768);
	w.u32(4294967295);
	w.i32(-5);
	w.f32(1.5);
	w.f64(Math.PI);
	w.str("héllo");
	w.str("x".repeat(300));
	const buf = w.done();
	const r = new bytes.Reader(buf);
	assert.deepStrictEqual([r.u8(), r.i8(), r.u16(), r.i16(), r.u32(), r.i32(), r.f32(), r.f64(), r.str()], [255, -128, 65535, -32768, 4294967295, -5, 1.5, Math.PI, "héllo"]);
	assert.strictEqual(r.str().length, 255);
	assert.strictEqual(r.left, 0);
	assert.throws(() => r.u8(), RangeError);
	assert.throws(() => w.put("u64", 1), TypeError);
	assert.throws(() => r.get("u64"), TypeError);
	// Typed arrays and views read too, from their own window.
	const u8 = new Uint8Array([9, 1, 2]);
	assert.strictEqual(new bytes.Reader(u8.subarray(1)).u16(), 258);
	assert.strictEqual(new bytes.Reader(new DataView(u8.buffer, 2)).u8(), 2);
	assert.strictEqual(bytes.decode("text", rd => rd.u8()), null);
	assert.strictEqual(bytes.decode(new ArrayBuffer(1), rd => rd.u16()), null);
	assert.strictEqual(bytes.decode(new Uint8Array([7]).buffer, rd => rd.u8()), 7);
	// A string that says it's longer than the packet.
	assert.strictEqual(bytes.decode(new Uint8Array([5, 65]).buffer, rd => rd.str()), null);
});

test("bytes: quantizers and wrapping sequence numbers", async() => {
	const { bytes } = await load();
	assert.strictEqual(bytes.clampInt(7.6, 0, 5), 5);
	assert.strictEqual(bytes.clampInt(NaN, -1, 1), 0);
	assert.ok(Object.is(bytes.clampInt(-0.2, -5, 5), 0), "not -0");
	assert.strictEqual(bytes.angleToU16(Math.PI), 32768);
	assert.strictEqual(bytes.angleToU16(-Math.PI / 2), 49152);
	assert.strictEqual(bytes.angleToU16(Math.PI * 2), 0);
	assert.strictEqual(bytes.angleToU16(undefined), 0);
	near(bytes.u16ToAngle(16384), Math.PI / 2);
	assert.strictEqual(bytes.toI16(1.5, 32), 48);
	assert.strictEqual(bytes.toI16(5000, 32), 32767);
	near(bytes.fromI16(48, 32), 1.5);
	assert.strictEqual(bytes.toI8Unit(-2), -127);
	near(bytes.fromI8Unit(127), 1);
	assert.ok(bytes.seqNewer(1, 65535));
	assert.ok(!bytes.seqNewer(65535, 1));
	assert.ok(!bytes.seqNewer(5, 5));
	assert.ok(bytes.seqNewer(44, 10, 8));
	assert.ok(bytes.seqNewer(2, 250, 8));
});

test("the entity codec sends only what changed and what went, and rebuilds the whole set", async() => {
	const { bytes } = await load();
	const codec = bytes.entityCodec([
		{ keys: ["px", "pz"], type: "i16" },
		{ keys: ["yaw"], type: "u16" },
		{ keys: ["flags"], type: "u8" }
	], { blank: () => ({ px: 0, pz: 0, yaw: 0, flags: 0 }) });
	const e = (kind, id, px, yaw = 0, flags = 0) => [bytes.keyOf(kind, id), { kind, id, px, pz: 0, yaw, flags }];
	const first = new Map([e(0, 1, 10), e(0, 2, 20), e(1, 7, -5, 100, 3)]);
	const whole = new bytes.Writer();
	codec.write(whole, first, null);
	const wholeBuf = whole.done();
	const got = codec.read(new bytes.Reader(wholeBuf), null);
	assert.deepStrictEqual(got, first);
	const second = new Map([e(0, 1, 10), e(0, 2, 21), e(0, 3, 0, 0, 1)]);
	const delta = new bytes.Writer();
	codec.write(delta, second, first);
	const deltaBuf = delta.done();
	assert.ok(deltaBuf.byteLength < wholeBuf.byteLength);
	assert.deepStrictEqual(codec.read(new bytes.Reader(deltaBuf), got), second);
	assert.deepStrictEqual(got, first, "the baseline isn't changed");
	// Nothing changed: just the two counts.
	const none = new bytes.Writer();
	codec.write(none, second, second);
	assert.strictEqual(none.done().byteLength, 4);
	// Wider masks for more field groups; too many groups or entities refused.
	const many = Array.from({ length: 12 }, (_, i) => ({ keys: [`f${i}`], type: "u8" }));
	const wide = bytes.entityCodec(many);
	const ent = { kind: 0, id: 1 };
	for (let i = 0; i < 12; i++) ent[`f${i}`] = i;
	const ww = new bytes.Writer();
	wide.write(ww, new Map([["0:1", ent]]));
	assert.deepStrictEqual(wide.read(new bytes.Reader(ww.done())).get("0:1"), ent);
	const huge = bytes.entityCodec(Array.from({ length: 20 }, (_, i) => ({ keys: [`f${i}`], type: "u8" })));
	const hw = new bytes.Writer();
	huge.write(hw, new Map([["0:1", { kind: 0, id: 1 }]]));
	assert.throws(() => bytes.entityCodec(Array.from({ length: 33 }, () => ({ keys: ["x"], type: "u8" }))), RangeError);
	const crowd = new Map();
	for (let i = 0; i < 0x10000; i++) crowd.set(`0:${i}`, { kind: 0, id: i & 0xffff, px: 0, pz: 0, yaw: 0, flags: 0 });
	assert.throws(() => codec.write(new bytes.Writer(), crowd), RangeError);
});

test("frames are cut into whole-millisecond commands, the fraction carried over", async() => {
	const { predict } = await load();
	const carry = { ms: 0 };
	assert.deepStrictEqual(predict.cmdLengths(16.6, carry), [16]);
	near(carry.ms, 0.6, 1e-9);
	assert.deepStrictEqual(predict.cmdLengths(16.6, carry), [17]);
	assert.deepStrictEqual(predict.cmdLengths(0.1, { ms: 0 }), []);
	assert.deepStrictEqual(predict.cmdLengths(120, { ms: 0 }), [50, 50, 20]);
	assert.deepStrictEqual(predict.cmdLengths(30, { ms: 0 }, 20), [20, 10]);
});

// A one-dimensional mover for prediction: speed 1 unit/s along f.
function mover() {
	const me = { x: 0 };
	const run = cmd => {
		me.x += cmd.f * cmd.msec / 1000;
	};
	return { me, run };
}

test("prediction: the host's word plus the commands it hasn't run lands where the guest is", async() => {
	const { predict } = await load();
	const p = predict.createPredictor();
	const local = mover();
	const hostSide = mover();
	for (let i = 0; i < 10; i++) local.run(p.issue({ f: 1, msec: 100 }, i * 0.1));
	assert.strictEqual(p.seq, 10);
	assert.deepStrictEqual(p.recent(2).map(c => c.seq), [9, 10]);
	for (const c of p.pending.slice(0, 4)) hostSide.run(c);
	const result = p.reconcile(4, 0.6, { position: () => local.me, reset: () => Object.assign(local.me, hostSide.me), run: local.run });
	near(local.me.x, 1);
	near(result.error, 0, 1e-9);
	assert.strictEqual(result.snapped, false);
	assert.strictEqual(p.pending.length, 6);
	near(p.ping, (0.6 - 0.3) * 1000, 1e-6);
	// A small disagreement is eased out from the drawn position, a big one snaps.
	hostSide.me.x = 0.4;
	p.reconcile(5, 0.7, { position: () => local.me, reset: () => Object.assign(local.me, hostSide.me), run: local.run });
	near(local.me.x, 0.9, 1e-9);
	near(p.offset.x, 0.1, 1e-9);
	p.decay(predict.SMOOTH);
	near(p.offset.x, 0.1 * Math.exp(-1), 1e-9);
	hostSide.me.x = 100;
	const big = p.reconcile(6, 0.8, { position: () => local.me, reset: () => Object.assign(local.me, hostSide.me), run: local.run });
	assert.strictEqual(big.snapped, true);
	assert.deepStrictEqual(p.offset, { x: 0, y: 0, z: 0 });
	hostSide.me.x = 100.1;
	assert.strictEqual(p.reconcile(6, 0.9, { position: () => local.me, reset: () => Object.assign(local.me, hostSide.me), run: local.run }, true).snapped, true, "forced");
	// An ack for a command it never kept (too old): no ping sample.
	const before = p.ping;
	p.reconcile(1, 5, { position: () => local.me, reset() {}, run() {} });
	assert.strictEqual(p.ping, before);
	p.reset();
	assert.strictEqual(p.pending.length, 0);
});

test("prediction keeps at most maxPending commands, and wraps its numbers when asked", async() => {
	const { predict } = await load();
	const p = predict.createPredictor({ maxPending: 3 });
	for (let i = 0; i < 5; i++) p.issue({ msec: 10 }, i);
	assert.deepStrictEqual(p.pending.map(c => c.seq), [3, 4, 5]);
	const w = predict.createPredictor({ seqBits: 8 });
	for (let i = 0; i < 300; i++) w.issue({ msec: 1 }, i);
	assert.strictEqual(w.seq, 300 % 256);
	const pos = { x: 0, z: 0 };
	w.reconcile(250, 400, { position: () => pos, reset() {}, run() {} });
	assert.deepStrictEqual(w.pending.map(c => c.seq).slice(0, 2), [251, 252]);
	assert.strictEqual(w.pending.length, 50, "251–255, then 0–44 after the wrap");
	assert.deepStrictEqual(w.pending.at(-1).seq, 44);
});

test("command gates run each command once, in order, within the time budget", async() => {
	const { server } = await load();
	const gate = server.createCmdGate();
	const cmd = (seq, msec = 16) => ({ seq, msec });
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(2), cmd(1), cmd(3)]).map(c => c.seq), [1, 2, 3]);
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(2), cmd(3), cmd(4)]).map(c => c.seq), [4], "repeats are skipped");
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(5, 1000)]), [], "over budget: dropped");
	assert.strictEqual(gate.lastSeq, 5, "and not waited for");
	gate.budget = 0;
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(6)]), []);
	server.refillGate(gate, 10);
	assert.strictEqual(gate.budget, server.MAX_BUDGET);
	assert.strictEqual(server.admitCmds(gate, [cmd(7), cmd(7)]).length, 1);
	server.resetGate(gate);
	assert.strictEqual(gate.lastSeq, null);
	// Wrapping numbers.
	const wrap = server.createCmdGate({ seqBits: 8 });
	wrap.lastSeq = 254;
	assert.deepStrictEqual(server.admitCmds(wrap, [cmd(1), cmd(255), cmd(0)]).map(c => c.seq), [255, 0, 1]);
});

test("command gates take the first command whatever its number, after a reset too", async() => {
	const { server } = await load();
	const cmd = seq => ({ seq, msec: 16 });
	// A predictor's numbers carry on across rounds: past half the wrap, a gate reset to 0 would
	// take nothing newer for minutes.
	const gate = server.createCmdGate({ seqBits: 16 });
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(40000)]).map(c => c.seq), [40000]);
	server.resetGate(gate);
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(40001), cmd(40002)]).map(c => c.seq), [40001, 40002]);
	// A page that came back numbers from 1 again.
	server.resetGate(gate);
	server.refillGate(gate, 1);
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(1), cmd(2)]).map(c => c.seq), [1, 2]);
	assert.deepStrictEqual(server.admitCmds(gate, [cmd(2)]), [], "and repeats are still skipped");
});

test("snapshots: deltas against what each guest acknowledged, never ahead of what was sent", async() => {
	const { server } = await load();
	const s = server.createSnapshots({ backup: 4 });
	s.add("g");
	assert.ok(s.has("g"));
	s.next();
	assert.strictEqual(s.baseFor("g"), null, "nothing acknowledged: whole");
	s.keep("g", { tick: 1 }, 40);
	s.next();
	s.keep("g", { tick: 2 }, 10);
	s.ack("g", 5);
	assert.strictEqual(s.baseFor("g"), null, "an ack from the future is ignored");
	s.ack("g", 2);
	s.ack("g", 1);
	assert.deepStrictEqual(s.baseFor("g"), { tick: 2 }, "acks only go forward");
	for (let i = 0; i < 5; i++) {
		s.next();
		s.keep("g", { tick: s.tick });
	}
	assert.strictEqual(s.baseFor("g"), null, "an ack older than the backup: whole again");
	assert.strictEqual(s.guests.get("g").bytesOut, 50);
	s.keep("nobody", {});
	s.ack("nobody", 1);
	assert.strictEqual(s.baseFor("nobody"), null);
	s.reset();
	assert.strictEqual(s.tick, 0);
	assert.strictEqual(s.guests.get("g").ackTick, 0);
	s.remove("g");
	assert.ok(!s.has("g"));
});

test("a guest takes only newer snapshots, keeps baselines and counts loss", async() => {
	const { client } = await load();
	const stats = client.createNetStats();
	const r = client.createReceiver({ backup: 3, stats });
	assert.ok(r.accept(1));
	r.keep(1, "one");
	assert.ok(!r.accept(1));
	assert.ok(r.accept(4), "2 and 3 lost");
	r.keep(4, "four");
	assert.strictEqual(r.get(1), undefined, "older than the backup");
	assert.strictEqual(r.get(4), "four");
	assert.strictEqual(r.lastTick, 4);
	stats.received(100);
	stats.sent(50);
	stats.frame(0.5);
	assert.strictEqual(stats.inRate, 0, "not a full window yet");
	stats.frame(0.5);
	assert.strictEqual(stats.inRate, 100);
	assert.strictEqual(stats.outRate, 50);
	near(stats.loss, 2 / 4);
	stats.frame(1);
	assert.strictEqual(stats.loss, 0);
	r.reset();
	assert.strictEqual(r.lastTick, 0);
	assert.ok(client.createReceiver().accept(1));
});

test("lag compensation: bodies put back where a guest saw them, within limits", async() => {
	const { lag } = await load();
	const h = lag.createHistory({ keep: 1, maxUnlag: 0.5 });
	assert.strictEqual(lag.posesAt(h, 0, 0)("a"), null);
	for (let i = 0; i <= 20; i++) {
		const t = i * 0.1;
		lag.record(h, t, new Map([["a", { pos: { x: t, y: 0, z: 0 }, yaw: 0, crouch: t > 1.5 }], ...(i < 15 ? [["b", { pos: { x: 0, y: 0, z: 0 } }]] : [])]));
	}
	assert.ok(h.frames[0].time >= 0.9, "a second kept");
	const at = lag.posesAt(h, 1.75, 2);
	near(at("a").pos.x, 1.75, 1e-9);
	assert.strictEqual(at("a").crouch, true);
	near(lag.posesAt(h, 0.2, 2)("a").pos.x, 1.5, 1e-9);
	assert.deepStrictEqual(lag.posesAt(h, 1.45, 2)("b"), { pos: { x: 0, y: 0, z: 0 } }, "only in one frame: as it was");
	assert.strictEqual(at("nobody"), null);
	// The same time again replaces the last frame.
	lag.record(h, 2, new Map([["a", { pos: { x: 9, y: 0, z: 0 } }]]));
	assert.strictEqual(lag.posesAt(h, 2, 2)("a").pos.x, 9);
	const one = lag.createHistory();
	lag.record(one, 1, new Map([["a", { pos: { x: 1, y: 0, z: 0 } }]]));
	assert.strictEqual(lag.posesAt(one, 0, 1)("a").pos.x, 1);
});

test("room codes look like the hub's", async() => {
	const { code } = await load();
	assert.match(code.roomCode(() => 0.99), /^[A-Z2-9]{5}$/);
	assert.strictEqual(code.parseRoomCode(" ab-cd e "), "ABCDE");
	assert.strictEqual(code.parseRoomCode("ABC0E"), null);
	assert.strictEqual(code.parseRoomCode("ABCD"), null);
	assert.strictEqual(code.parseRoomCode(null), null);
});
