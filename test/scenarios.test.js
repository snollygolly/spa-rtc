"use strict";

// The whole stack end to end: pages on one in-memory bus (local.js), each behind netsim.js's bad
// network, each with a room (room.js), playing a toy game built on the sync kit the way a real game
// would: commands with prediction (predict.js), a host that gates them (server.js) and sends delta
// snapshots against what each guest acknowledged (bytes.js), and guests that interpolate everyone
// else (snapbuf.js). Everything runs on a fake clock, with a seeded rng, so every run is the same.

const { test } = require("node:test");
const assert = require("node:assert");
const { createBus, createTimers } = require("./support");

const FRAME_MS = 16;
const SNAP_EVERY = 3;
const POS_SCALE = 64;

// A seeded rng (an LCG), so the network drops and delays the same packets each run.
function lcg(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

async function kit() {
	return {
		...(await import("../src/local.js")),
		...(await import("../src/netsim.js")),
		...(await import("../src/room.js")),
		...(await import("../src/bytes.js")),
		...(await import("../src/predict.js")),
		...(await import("../src/server.js")),
		...(await import("../src/client.js")),
		...(await import("../src/snapbuf.js"))
	};
}

// The toy game's wire format.
function codecs(k) {
	const ents = k.entityCodec([{ keys: ["px", "pz"], type: "i16" }], { blank: () => ({ px: 0, pz: 0 }) });
	return {
		encodeCmds(cmds, ackTick) {
			const w = new k.Writer();
			w.u8(1);
			w.u32(ackTick);
			w.u8(cmds.length);
			for (const c of cmds) {
				w.u32(c.seq);
				w.u8(c.msec);
				w.i8(c.fq);
				w.i8(c.sq);
			}
			return w.done();
		},
		decodeCmds: data => k.decode(data, r => {
			if (r.u8() !== 1) return null;
			const ackTick = r.u32();
			const n = r.u8();
			const cmds = [];
			for (let i = 0; i < n; i++) cmds.push({ seq: r.u32(), msec: r.u8(), fq: r.i8(), sq: r.i8() });
			return { ackTick, cmds };
		}),
		encodeSnap(state, base) {
			const w = new k.Writer();
			w.u8(2);
			w.u32(state.tick);
			w.u32(base ? base.tick : 0);
			w.f64(state.time);
			w.u32(state.ackSeq);
			w.f64(state.self.x);
			w.f64(state.self.z);
			ents.write(w, state.ents, base ? base.ents : null);
			return w.done();
		},
		decodeSnap: (data, baseline) => k.decode(data, r => {
			if (r.u8() !== 2) return null;
			const tick = r.u32();
			const baseTick = r.u32();
			const base = baseTick ? baseline(baseTick) : null;
			if (baseTick && !base) return { tick, missingBase: true };
			const time = r.f64();
			const ackSeq = r.u32();
			const own = { x: r.f64(), z: r.f64() };
			return { tick, baseTick, time, ackSeq, self: own, ents: ents.read(r, base ? base.ents : null) };
		})
	};
}

// One step of the toy game: walk at 3 m/s.
function walk(body, cmd) {
	body.x += (cmd.fq / 127) * 3 * cmd.msec / 1000;
	body.z += (cmd.sq / 127) * 3 * cmd.msec / 1000;
}

async function stage({ sim = null, seed = 1, followHost = false } = {}) {
	const k = await kit();
	const wire = codecs(k);
	const bus = createBus();
	const timers = createTimers();
	const rng = lcg(seed);
	const now = () => timers.now();
	const pages = [];

	// Each guest's own link is `sim` (both ways); the host's is clean, so a guest's round trip is
	// twice the latency.
	function transport(simulated) {
		const base = k.createLocalTransport({ BroadcastChannel: bus.Channel, timers, followHost });
		// A switch to cut the page's network both ways (a dead link, a frozen tab).
		let cut = false;
		const wrapped = {
			...base,
			on(name, fn) {
				if (name === "message") base.on(name, (...a) => {
					if (!cut) fn(...a);
				});
				else base.on(name, fn);
			},
			send(...a) {
				if (!cut) base.send(...a);
			},
			cut(on) {
				cut = on;
			}
		};
		return k.withNetsim(wrapped, simulated ? sim : null, { rng, timers, now: () => timers.now() / 1000 });
	}

	// The host's game.
	function hostGame(name) {
		const t = transport(false);
		const game = { bodies: new Map(), gates: new Map(), netIds: new Map(), parked: new Map(), sent: new Map(), time: 0, nextNet: 1 };
		const snaps = k.createSnapshots();
		const room = k.createRoom(t, {
			name,
			followHost,
			timers,
			now,
			on: {
				joined(player, { rejoinOf }) {
					const old = rejoinOf && game.parked.get(rejoinOf);
					if (old) game.parked.delete(rejoinOf);
					game.bodies.set(player.id, old || { x: 0, z: 0, score: 0 });
					game.netIds.set(player.id, game.nextNet++);
					game.gates.set(player.id, k.createCmdGate());
					game.sent.set(player.id, new Map());
					snaps.add(player.id);
					// Catch-up beyond the start message: what's yours.
					room.sendTo(player.id, "reliable", { k: "you", score: game.bodies.get(player.id).score });
				},
				left(id) {
					game.parked.set(id, game.bodies.get(id));
					game.bodies.delete(id);
					game.gates.delete(id);
					snaps.remove(id);
				},
				message(from, channel, data) {
					if (channel !== "fast") return;
					const packet = wire.decodeCmds(data);
					const body = game.bodies.get(from);
					if (!packet || !body) return;
					snaps.ack(from, packet.ackTick);
					for (const cmd of k.admitCmds(game.gates.get(from), packet.cmds)) walk(body, cmd);
				}
			}
		});
		const page = { kind: "host", t, room, game, frames: 0 };
		page.frame = () => {
			game.time += FRAME_MS / 1000;
			for (const gate of game.gates.values()) k.refillGate(gate, FRAME_MS / 1000);
			// A point a second for everyone in.
			if (Math.floor(game.time) !== Math.floor(game.time - FRAME_MS / 1000)) for (const b of game.bodies.values()) b.score++;
			if (++page.frames % SNAP_EVERY || room.room.phase !== "playing") return;
			snaps.next();
			const ents = new Map();
			for (const [id, b] of game.bodies) {
				const n = game.netIds.get(id);
				ents.set(k.keyOf(0, n), { kind: 0, id: n, px: k.toI16(b.x, POS_SCALE), pz: k.toI16(b.z, POS_SCALE) });
			}
			for (const [id, b] of game.bodies) {
				const state = { tick: snaps.tick, time: game.time, ackSeq: game.gates.get(id).lastSeq, self: { x: b.x, z: b.z }, ents };
				const data = wire.encodeSnap(state, snaps.baseFor(id));
				snaps.keep(id, state, data.byteLength);
				game.sent.get(id).set(state.tick, ents);
				room.sendTo(id, "fast", data);
			}
		};
		pages.push(page);
		return page;
	}

	// A guest's game.
	function guestGame(name, seat) {
		const t = transport(true);
		const me = { x: 0, z: 0, score: null };
		const predictor = k.createPredictor();
		const stats = k.createNetStats();
		const receiver = k.createReceiver({ stats });
		const clock = k.createClock();
		const buffer = k.createBuffer();
		const carry = { ms: 0 };
		const page = { kind: "guest", t, me, predictor, stats, receiver, clock, buffer, localTime: 0, decoded: [], missingBase: 0, input: { f: 0, s: 0 }, started: null };
		const room = k.createRoom(t, {
			name,
			seat,
			followHost,
			timers,
			now,
			on: {
				start(data) {
					page.started = data;
				},
				message(from, channel, data) {
					if (channel === "reliable") {
						if (data && data.k === "you") me.score = data.score;
						return;
					}
					stats.received(data.byteLength);
					const s = wire.decodeSnap(data, tick => receiver.get(tick));
					if (!s) return;
					if (s.missingBase) {
						page.missingBase++;
						return;
					}
					if (!receiver.accept(s.tick)) return;
					receiver.keep(s.tick, s);
					page.decoded.push(s);
					k.clockSample(clock, s.time, page.localTime);
					k.pushFrame(buffer, s.time, s.ents);
					predictor.reconcile(s.ackSeq, page.localTime, { position: () => me, reset: () => Object.assign(me, s.self), run: cmd => walk(me, cmd) });
				}
			}
		});
		page.room = room;
		page.frame = () => {
			page.localTime += FRAME_MS / 1000;
			stats.frame(FRAME_MS / 1000);
			predictor.decay(FRAME_MS / 1000);
			if (!room.room.connected || room.room.phase !== "playing") return;
			for (const msec of k.cmdLengths(FRAME_MS, carry)) {
				const cmd = predictor.issue({ msec, fq: k.toI8Unit(page.input.f), sq: k.toI8Unit(page.input.s) }, page.localTime);
				walk(me, cmd);
			}
			const packet = wire.encodeCmds(predictor.recent(3), receiver.lastTick);
			stats.sent(packet.byteLength);
			room.sendToHost("fast", packet);
		};
		// Where this guest draws everyone (x, z by net id) now.
		page.view = () => {
			const t2 = k.renderTime(clock, page.localTime);
			return k.sample(buffer, t2, { pose: e => ({ id: e.id, x: e.px / POS_SCALE, z: e.pz / POS_SCALE }) });
		};
		pages.push(page);
		return page;
	}

	// Runs `ms` of game time: the clock, the network, then every page's frame.
	async function play(ms, each = () => {}) {
		for (let t = 0; t < ms; t += FRAME_MS) {
			timers.run(FRAME_MS);
			bus.flush();
			for (const p of pages) if (!p.room.room.closed) p.frame();
			bus.flush();
			each(t);
		}
		await bus.settle();
	}

	return { k, bus, timers, hostGame, guestGame, play, settle: () => bus.settle() };
}

async function lobby(s, n = 2) {
	const host = s.hostGame("Host");
	host.room.host(8);
	await s.settle();
	const guests = [];
	for (let i = 0; i < n; i++) {
		const g = s.guestGame(`G${i}`, `seat-${i}`);
		g.room.join(host.room.room.code);
		await s.play(400);
		guests.push(g);
	}
	return { host, guests };
}

const BAD = { latency: 0.1, jitter: 0.03, loss: 0.2 };

test("prediction and delta snapshots hold up under 100 ms ± 30 ms and 20% loss", async() => {
	const s = await stage({ sim: BAD, seed: 7 });
	const { host, guests } = await lobby(s, 2);
	host.room.start({ round: 1 });
	await s.play(200);
	// Four seconds of wandering, changing direction every half second, then a second standing still.
	await s.play(4000, t => {
		const phase = Math.floor(t / 500);
		guests[0].input = { f: Math.sin(phase), s: Math.cos(phase * 1.7) };
		guests[1].input = { f: phase % 2 ? 1 : -0.5, s: 0.3 };
	});
	for (const g of guests) g.input = { f: 0, s: 0 };
	await s.play(1500);
	for (const g of guests) {
		const body = host.game.bodies.get(g.room.room.you);
		assert.ok(Math.hypot(body.x, body.z) > 0.5, "they really moved");
		assert.ok(Math.abs(g.me.x - body.x) < 1e-9 && Math.abs(g.me.z - body.z) < 1e-9, `the guest's prediction matches the host: ${g.me.x},${g.me.z} vs ${body.x},${body.z}`);
		assert.ok(Math.hypot(g.predictor.offset.x, g.predictor.offset.z) < 0.01, "and any correction has eased out");
		assert.strictEqual(g.missingBase, 0, "every delta was against a baseline the guest had");
		const deltas = g.decoded.filter(d => d.baseTick).length;
		assert.ok(deltas > g.decoded.length * 0.9, `nearly all deltas: ${deltas} of ${g.decoded.length}`);
		// Every snapshot read back exactly as the host sent it.
		const sent = host.game.sent.get(g.room.room.you);
		for (const snap of g.decoded) assert.deepStrictEqual(snap.ents, sent.get(snap.tick), `tick ${snap.tick}`);
		const ticks = host.game.sent.get(g.room.room.you).size;
		assert.ok(g.decoded.length > ticks * 0.6 && g.decoded.length < ticks * 0.95, `about a fifth lost: ${g.decoded.length} of ${ticks}`);
		assert.ok(g.predictor.ping > 170 && g.predictor.ping < 320, `ping ${g.predictor.ping}`);
	}
	// Each guest draws the other where the host has them (they've stood still a while).
	const other = guests[0].view().find(p => p.id === host.game.netIds.get(guests[1].room.room.you));
	const truth = host.game.bodies.get(guests[1].room.room.you);
	assert.ok(Math.abs(other.x - truth.x) < 1 / POS_SCALE && Math.abs(other.z - truth.z) < 1 / POS_SCALE);
});

test("a guest who drops mid-round and comes back with its seat is caught up and keeps its score", async() => {
	const s = await stage({ sim: { latency: 0.05, jitter: 0.01, loss: 0.05 }, seed: 3 });
	const { host, guests } = await lobby(s, 2);
	host.room.start({ round: 2 });
	guests[0].input = { f: 1, s: 0 };
	await s.play(3000);
	const oldId = guests[0].room.room.you;
	const before = { ...host.game.bodies.get(oldId) };
	assert.ok(before.score >= 2);
	guests[0].room.leave();
	await s.play(1000);
	assert.ok(!host.game.bodies.has(oldId), "gone");
	assert.strictEqual(host.room.room.players.length, 2);
	const back = s.guestGame("G0", "seat-0");
	back.room.join(host.room.room.code);
	await s.play(1500);
	const id = back.room.room.you;
	assert.notStrictEqual(id, oldId);
	assert.deepStrictEqual(back.started, { round: 2 }, "the round's start");
	assert.ok(back.me.score >= before.score, "its score, not a fresh one");
	assert.ok(host.game.bodies.get(id).score >= before.score);
	assert.ok(Math.abs(back.me.x - host.game.bodies.get(id).x) < 1e-9, "and its place: the first snapshot put it there");
	assert.ok(back.decoded.length > 10);
	// The other guest never noticed.
	assert.strictEqual(guests[1].room.room.closed, false);
	assert.strictEqual(guests[1].room.room.players.length, 3, "the host, it, and the one back");
});

test("a guest whose link dies is dropped after the silence timeout, and can come back to its seat", async() => {
	const s = await stage({ sim: { latency: 0.04, jitter: 0, loss: 0 }, seed: 5 });
	const { host, guests } = await lobby(s, 1);
	host.room.start({ round: 3 });
	await s.play(2500);
	const oldId = guests[0].room.room.you;
	const score = host.game.bodies.get(oldId).score;
	guests[0].t.cut(true);
	await s.play(s.k.SILENCE_MS + 2000);
	assert.ok(!host.game.bodies.has(oldId), "the host gave up on it");
	assert.strictEqual(guests[0].room.room.closeReason, "timeout", "and it on the host");
	const back = s.guestGame("G0", "seat-0");
	back.room.join(host.room.room.code);
	await s.play(1000);
	assert.ok(host.game.bodies.get(back.room.room.you).score >= score);
});

test("the host leaving ends the round for everyone", async() => {
	const s = await stage({ sim: { latency: 0.05, jitter: 0.01, loss: 0.1 }, seed: 9 });
	const { host, guests } = await lobby(s, 2);
	host.room.start({ round: 4 });
	await s.play(1000);
	host.room.leave();
	await s.play(500);
	for (const g of guests) assert.strictEqual(g.room.room.closeReason, "host_left");
});

test("with followHost the oldest guest takes over and the other reconnects to it", async() => {
	const s = await stage({ sim: { latency: 0.05, jitter: 0.01, loss: 0.1 }, seed: 11, followHost: true });
	const { host, guests } = await lobby(s, 2);
	host.room.start({ round: 5 });
	await s.play(1000);
	host.room.leave();
	await s.play(1000);
	const [a, b] = guests;
	assert.strictEqual(a.room.isHost, true);
	assert.strictEqual(b.room.room.closed, false);
	assert.strictEqual(b.room.room.hostId, a.room.room.you);
	assert.strictEqual(b.room.room.connected, true);
	assert.deepStrictEqual(a.room.room.players.map(p => p.id), [a.room.room.you, b.room.room.you]);
	// Still in touch a while later: the heartbeat keeps both sides.
	await s.play(s.k.SILENCE_MS + 1000);
	assert.strictEqual(b.room.room.closed, false);
	assert.strictEqual(a.room.room.players.length, 2);
	assert.ok(b.room.room.ping > 0);
});
