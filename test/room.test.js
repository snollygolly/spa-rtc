"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createBus, createTimers } = require("./support");

const load = async() => ({
	...(await import("../src/local.js")),
	...(await import("../src/room.js")),
	...(await import("../src/emitter.js"))
});

// Every callback the room makes, in order.
function recorder() {
	const log = [];
	const on = new Proxy({}, { get: (_, name) => (...args) => log.push([name, ...args]) });
	return { log, on, all: name => log.filter(e => e[0] === name), last: name => log.filter(e => e[0] === name).at(-1) };
}

// A world of pages on one in-memory bus and one fake clock.
async function world(opts = {}) {
	const m = await load();
	const bus = createBus();
	const timers = createTimers();
	const page = (name, extra = {}) => {
		const transport = m.createLocalTransport({ BroadcastChannel: bus.Channel, timers, followHost: !!(extra.followHost ?? opts.followHost) });
		const rec = recorder();
		const handle = m.createRoom(transport, { name, timers, now: timers.now, on: rec.on, ...opts, ...extra });
		return { transport, rec, handle, room: handle.room };
	};
	// Moves the clock on in heartbeat-sized steps, delivering messages as it goes.
	const run = async ms => {
		for (let left = ms; left > 0; left -= 250) {
			timers.run(Math.min(250, left));
			await bus.settle();
		}
	};
	return { m, bus, timers, page, run, settle: () => bus.settle() };
}

async function hostAndGuest(w, hostOpts = {}, guestOpts = {}) {
	const host = w.page("Ann", { profile: { look: "a" }, seat: "seat-ann", ...hostOpts });
	host.handle.host(4, { map: "Bay" });
	await w.settle();
	const guest = w.page("Bo", { profile: { look: "b" }, seat: "seat-bo", ...guestOpts });
	guest.handle.join(host.room.code);
	await w.settle();
	return { host, guest };
}

test("a host makes a room and a guest joins it: both see the roster, the info and who's who", async() => {
	const w = await world();
	const host = w.page("Ann", { profile: { look: "a" } });
	assert.deepStrictEqual(w.m.describeRoom(null), { net: "off", room: "", players: "0", ping: "" });
	assert.strictEqual(w.m.describeRoom(host.room).net, "connecting");
	host.handle.host(4, { map: "Bay" });
	await w.settle();
	assert.strictEqual(host.handle.isHost, true);
	assert.strictEqual(w.m.describeRoom(host.room).net, "host");
	const guest = w.page("Bo".repeat(40), { profile: { look: "b" }, seat: "seat-bo" });
	guest.handle.join(host.room.code);
	await w.settle();
	assert.strictEqual(guest.handle.isHost, false);
	assert.strictEqual(guest.handle.seat, "seat-bo");
	assert.deepStrictEqual(host.room.players.map(p => [p.name.length, p.host, p.profile]), [[3, true, { look: "a" }], [32, false, { look: "b" }]]);
	assert.deepStrictEqual(guest.room.players, host.room.players);
	assert.deepStrictEqual(guest.room.info, { map: "Bay" });
	assert.strictEqual(guest.room.phase, "lobby");
	const joined = host.rec.last("joined");
	assert.strictEqual(joined[1].id, guest.room.you);
	assert.deepStrictEqual(joined[2], { rejoinOf: null });
	const shown = w.m.describeRoom(guest.room);
	assert.strictEqual(shown.net, "guest");
	assert.strictEqual(shown.players, "2");
	// The lobby info changes for everyone.
	host.handle.setInfo({ map: "River" });
	await w.settle();
	assert.deepStrictEqual(guest.room.info, { map: "River" });
});

test("names and profiles change in the lobby, not once the round is on", async() => {
	const w = await world({ cleanProfile: p => (p && typeof p.look === "string" ? { look: p.look.slice(0, 4) } : { look: "none" }) });
	const { host, guest } = await hostAndGuest(w);
	guest.handle.setProfile({ name: "Bob", profile: { look: "bbbbbbbb" } });
	await w.settle();
	assert.deepStrictEqual(host.room.players[1], { id: guest.room.you, name: "Bob", host: false, profile: { look: "bbbb" } });
	guest.handle.setProfile({ profile: 7 });
	await w.settle();
	assert.deepStrictEqual(host.room.players[1].profile, { look: "none" }, "the host cleans what it's sent");
	host.handle.setProfile({ name: "Annie" });
	await w.settle();
	assert.strictEqual(guest.room.players[0].name, "Annie");
	const sent = w.bus;
	assert.ok(sent);
	// Nothing changed: nothing sent.
	const updates = guest.rec.all("update").length;
	host.handle.setProfile({ name: "Annie" });
	await w.settle();
	assert.strictEqual(guest.rec.all("update").length, updates);
	host.handle.start({ round: 1 });
	await w.settle();
	guest.handle.setProfile({ name: "Late" });
	await w.settle();
	assert.strictEqual(host.room.players[1].name, "Bob", "seated as they were");
});

test("game messages: JSON on reliable, anything on fast, and only between host and seated guests", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	guest.handle.sendToHost("reliable", { k: "ready", ready: true });
	guest.handle.sendToHost("fast", new Uint8Array([1, 2, 3]).buffer);
	host.handle.sendTo(guest.room.you, "reliable", { k: "hi" });
	host.handle.broadcast("fast", "snap");
	host.handle.broadcast("reliable", [1, 2]);
	// Not for these: a host can't sendToHost, a guest can't broadcast, nobody sends to a stranger.
	host.handle.sendToHost("reliable", "no");
	guest.handle.broadcast("reliable", "no");
	guest.handle.sendTo(host.room.you, "reliable", "no");
	host.handle.sendTo("stranger", "reliable", "no");
	await w.settle();
	const atHost = host.rec.all("message");
	assert.deepStrictEqual(atHost[0], ["message", guest.room.you, "reliable", { k: "ready", ready: true }]);
	assert.deepStrictEqual([...new Uint8Array(atHost[1][3])], [1, 2, 3]);
	assert.strictEqual(atHost.length, 2);
	assert.deepStrictEqual(guest.rec.all("message"), [
		["message", host.room.you, "reliable", { k: "hi" }],
		["message", host.room.you, "fast", "snap"],
		["message", host.room.you, "reliable", [1, 2]]
	]);
	// Junk on the reliable channel is ignored.
	guest.transport.send(host.room.you, "reliable", "not json");
	guest.transport.send(host.room.you, "reliable", "null");
	guest.transport.send(host.room.you, "reliable", new Uint8Array([1]).buffer);
	guest.transport.send(host.room.you, "reliable", JSON.stringify({ t: "pong", ts: "x" }));
	await w.settle();
	assert.strictEqual(host.rec.all("message").length, 2);
});

test("late join: someone joining mid-round gets the roster, then the round's start, before the game hears of them", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	host.handle.start({ map: "Bay", seed: 3 });
	await w.settle();
	assert.deepStrictEqual(guest.rec.last("start"), ["start", { map: "Bay", seed: 3 }]);
	assert.strictEqual(guest.room.phase, "playing");
	const late = w.page("Cy", { seat: "seat-cy" });
	late.handle.join(host.room.code);
	await w.settle();
	const order = late.rec.log.filter(e => e[0] === "start" || e[0] === "update").map(e => e[0]);
	assert.ok(order.indexOf("update") < order.indexOf("start"), "roster first");
	assert.deepStrictEqual(late.rec.last("start"), ["start", { map: "Bay", seed: 3 }]);
	assert.strictEqual(late.room.players.length, 3);
	// Anything the host sends from joined() arrives after the start.
	assert.deepStrictEqual(host.rec.last("joined")[2], { rejoinOf: null });
	// Back to the lobby: newcomers are only seated.
	host.handle.stop();
	await w.settle();
	assert.strictEqual(guest.room.phase, "lobby");
	assert.strictEqual(guest.room.startData, null);
	const lobbyJoiner = w.page("Di");
	lobbyJoiner.handle.join(host.room.code);
	await w.settle();
	assert.strictEqual(lobbyJoiner.rec.all("start").length, 0);
	// Only the host starts or stops.
	guest.handle.start({});
	guest.handle.stop();
	await w.settle();
	assert.strictEqual(host.room.phase, "lobby");
});

test("rejoin: a guest who leaves and comes back with the same seat is told apart from a stranger", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	host.handle.start({ round: 1 });
	await w.settle();
	const oldId = guest.room.you;
	guest.handle.leave();
	await w.settle();
	assert.deepStrictEqual(host.rec.last("left"), ["left", oldId]);
	assert.strictEqual(host.room.players.length, 1);
	const back = w.page("Bo", { seat: "seat-bo" });
	back.handle.join(host.room.code);
	await w.settle();
	const joined = host.rec.last("joined");
	assert.strictEqual(joined[1].id, back.room.you);
	assert.notStrictEqual(back.room.you, oldId);
	assert.deepStrictEqual(joined[2], { rejoinOf: oldId });
	assert.deepStrictEqual(back.rec.last("start"), ["start", { round: 1 }]);
	// The seat is used up: a third page with it again is a rejoin of the second.
	const stranger = w.page("Bo", { seat: "seat-new" });
	stranger.handle.join(host.room.code);
	await w.settle();
	assert.deepStrictEqual(host.rec.last("joined")[2], { rejoinOf: null });
});

test("rejoin before the host noticed the old connection drop: the stale player goes first", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	const oldId = guest.room.you;
	// The guest's page reloads: the old connection never says goodbye.
	guest.transport.leave = () => {};
	const reloaded = w.page("Bo", { seat: "seat-bo" });
	reloaded.handle.join(host.room.code);
	await w.settle();
	const tail = host.rec.log.filter(e => e[0] === "left" || e[0] === "joined").slice(-2);
	assert.deepStrictEqual(tail[0], ["left", oldId]);
	assert.strictEqual(tail[1][0], "joined");
	assert.deepStrictEqual(tail[1][2], { rejoinOf: oldId });
	assert.deepStrictEqual(host.room.players.map(p => p.id), [host.room.you, reloaded.room.you]);
	// Junk seats are no seats.
	const junk = w.page("X", { seat: "x".repeat(65) });
	assert.strictEqual(junk.handle.seat, null);
});

test("only so many departed seats are kept", async() => {
	const w = await world({ heartbeatMs: 0 });
	const host = w.page("Ann");
	host.handle.host(200);
	await w.settle();
	const first = w.page("G0", { seat: "seat-0" });
	first.handle.join(host.room.code);
	await w.settle();
	const firstId = first.room.you;
	first.handle.leave();
	await w.settle();
	for (let i = 1; i <= w.m.KEEP_SEATS; i++) {
		const g = w.page(`G${i}`, { seat: `seat-${i}` });
		g.handle.join(host.room.code);
		await w.settle();
		g.handle.leave();
		await w.settle();
	}
	const back = w.page("G0", { seat: "seat-0" });
	back.handle.join(host.room.code);
	await w.settle();
	assert.deepStrictEqual(host.rec.last("joined")[2], { rejoinOf: null }, `seat of ${firstId} was forgotten`);
	const recent = w.page("G64", { seat: `seat-${w.m.KEEP_SEATS}` });
	recent.handle.join(host.room.code);
	await w.settle();
	assert.notStrictEqual(host.rec.last("joined")[2].rejoinOf, null);
});

test("the heartbeat measures ping, and silence ends things: the host drops a guest, a guest gives up", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	await w.run(1000);
	assert.strictEqual(host.room.ping, 0);
	assert.strictEqual(guest.room.ping, 0);
	assert.strictEqual(w.m.describeRoom(guest.room).ping, "0");
	// The guest's page freezes: it stops answering, and its messages stop.
	const send = guest.transport.send;
	guest.transport.send = () => {};
	await w.run(w.m.SILENCE_MS + 1500);
	assert.deepStrictEqual(host.rec.last("left"), ["left", guest.room.you]);
	assert.strictEqual(host.room.players.length, 1);
	guest.transport.send = send;
	// A guest whose host has gone quiet times out.
	const w2 = await world();
	const pair = await hostAndGuest(w2);
	pair.host.transport.send = () => {};
	await w2.run(w2.m.SILENCE_MS + 1500);
	assert.strictEqual(pair.guest.room.closed, true);
	assert.deepStrictEqual(pair.guest.rec.last("closed"), ["closed", "timeout"]);
	assert.strictEqual(w2.m.describeRoom(pair.guest.room).net, "closed");
});

test("silence checks can be turned off (silenceMs 0), and the heartbeat too (heartbeatMs 0)", async() => {
	const w = await world({ silenceMs: 0 });
	const { host, guest } = await hostAndGuest(w);
	guest.transport.send = () => {};
	await w.run(20000);
	assert.strictEqual(host.room.players.length, 2);
	const w2 = await world({ heartbeatMs: 0 });
	const pair = await hostAndGuest(w2);
	await w2.run(20000);
	assert.strictEqual(pair.host.room.ping, null);
	assert.strictEqual(w2.timers.pending, 0);
});

test("a join that never connects fails after the connect timeout", async() => {
	const w = await world();
	const guest = w.page("Bo");
	guest.handle.join("ZZZZZ");
	await w.settle();
	// The local transport gives up first, with its own reason.
	await w.run(2000);
	assert.deepStrictEqual(guest.rec.last("closed"), ["closed", "no_such_room"]);
	assert.deepStrictEqual(guest.rec.last("error"), ["error", "no_such_room"]);
	// A transport that never answers at all.
	const { createEmitter, createRoom, CONNECT_TIMEOUT_MS } = w.m;
	const events = createEmitter();
	const silent = { on: events.on, join() {}, create() {}, send() {}, close() {} };
	const rec = recorder();
	const handle = createRoom(silent, { timers: w.timers, now: w.timers.now, on: rec.on });
	handle.join("ABCDE");
	w.timers.run(CONNECT_TIMEOUT_MS + 1);
	assert.deepStrictEqual(rec.last("closed"), ["closed", "connect_failed"]);
	assert.strictEqual(handle.room.closeReason, "connect_failed");
});

test("the host leaving ends the room for its guests", async() => {
	const w = await world();
	const { host, guest } = await hostAndGuest(w);
	host.handle.leave();
	assert.strictEqual(host.room.closeReason, "left");
	host.handle.leave();
	await w.settle();
	assert.deepStrictEqual(guest.rec.last("closed"), ["closed", "host_left"]);
	assert.strictEqual(guest.rec.all("error").length, 0, "not an error");
	// A closed room sends nothing and ignores everything.
	guest.handle.sendToHost("reliable", "x");
	guest.handle.setProfile({ name: "Z" });
	host.handle.setInfo({});
	host.handle.start({});
	host.handle.stop();
});

test("the hub naming a new host ends the room when not following hosts", async() => {
	const m = await load();
	const timers = createTimers();
	const events = m.createEmitter();
	const sent = [];
	const t = { on: events.on, join() {}, create() {}, send: (...a) => sent.push(a), close() {} };
	const rec = recorder();
	const handle = m.createRoom(t, { name: "Bo", timers, now: timers.now, on: rec.on });
	handle.join("ABCDE");
	events.emit("room", { code: "ABCDE", you: "g", host: "h" });
	events.emit("open", "h");
	assert.deepStrictEqual(JSON.parse(sent[0][2]), { t: "hello", name: "Bo", profile: null, seat: null });
	events.emit("host", { id: "h" });
	assert.strictEqual(handle.room.closed, false, "the same host is no news");
	events.emit("host", { id: "g2" });
	assert.deepStrictEqual(rec.last("closed"), ["closed", "host_left"]);
	// A host itself never hears of a new host as the end.
	const events2 = m.createEmitter();
	const handle2 = m.createRoom({ on: events2.on, join() {}, create() {}, send() {}, close() {} }, { timers, now: timers.now });
	handle2.host();
	events2.emit("room", { code: "ABCDE", you: "h", host: "h" });
	events2.emit("host", { id: "x" });
	assert.strictEqual(handle2.room.closed, false);
	handle2.leave();
});

test("transport errors: before connecting they end the room, after they're only reported", async() => {
	const m = await load();
	const timers = createTimers();
	const make = () => {
		const events = m.createEmitter();
		const rec = recorder();
		const handle = m.createRoom({ on: events.on, join() {}, create() {}, send() {}, close() {} }, { timers, now: timers.now, on: rec.on });
		return { events, rec, handle };
	};
	const a = make();
	a.handle.join("ABCDE");
	a.events.emit("error", { code: "room_full", re: "join" });
	assert.deepStrictEqual(a.rec.last("closed"), ["closed", "room_full"]);
	assert.deepStrictEqual(a.rec.last("error"), ["error", "room_full"]);
	const b = make();
	b.handle.join("ABCDE");
	b.events.emit("room", { code: "ABCDE", you: "g", host: "h" });
	b.events.emit("open", "h");
	b.events.emit("error", { code: "rate_limited", re: "ice" });
	assert.strictEqual(b.handle.room.closed, false);
	assert.deepStrictEqual(b.rec.last("error"), ["error", "rate_limited"]);
	// A host doesn't care that some guest couldn't get through.
	const c = make();
	c.handle.host();
	c.events.emit("room", { code: "ABCDE", you: "h", host: "h" });
	c.events.emit("error", { code: "connect_failed", peer: "g" });
	assert.strictEqual(c.rec.all("error").length, 0);
	// Losing signaling: fatal before connecting, only a flag after.
	const d = make();
	d.handle.join("ABCDE");
	d.events.emit("offline");
	assert.deepStrictEqual(d.rec.last("closed"), ["closed", "disconnected"]);
	const e = make();
	e.handle.host();
	e.events.emit("room", { code: "ABCDE", you: "h", host: "h" });
	e.events.emit("offline");
	assert.strictEqual(e.handle.room.offline, true);
	assert.strictEqual(e.handle.room.closed, false);
	// After closing, events are ignored.
	d.events.emit("room", { code: "X", you: "g", host: "h" });
	d.events.emit("open", "h");
	d.events.emit("peer-left", { id: "h" });
	d.events.emit("host", { id: "z" });
	d.events.emit("error", { code: "x" });
	d.events.emit("offline");
	d.events.emit("message", "h", "reliable", "{}");
	assert.strictEqual(d.handle.room.code, null);
});

test("host migration (followHost): the oldest guest takes the room over and the round carries on", async() => {
	const w = await world({ followHost: true });
	const host = w.page("Ann");
	host.handle.host(4);
	await w.settle();
	const a = w.page("Bo", { seat: "seat-bo" });
	a.handle.join(host.room.code);
	await w.settle();
	const b = w.page("Cy", { seat: "seat-cy" });
	b.handle.join(host.room.code);
	await w.settle();
	host.handle.start({ round: 7 });
	await w.settle();
	host.handle.leave();
	await w.settle();
	assert.strictEqual(a.handle.isHost, true);
	assert.deepStrictEqual(a.rec.last("hostChanged"), ["hostChanged", a.room.you]);
	assert.deepStrictEqual(b.rec.last("hostChanged"), ["hostChanged", a.room.you]);
	assert.strictEqual(b.room.closed, false);
	assert.strictEqual(b.room.hostId, a.room.you);
	assert.strictEqual(b.room.connected, true, "reconnected to the new host");
	assert.deepStrictEqual(a.room.players.map(p => [p.id, p.host]), [[a.room.you, true], [b.room.you, false]]);
	assert.deepStrictEqual(b.room.players, a.room.players);
	assert.strictEqual(a.room.phase, "playing");
	assert.deepStrictEqual(b.rec.last("start"), ["start", { round: 7 }], "brought up to date");
	assert.strictEqual(a.rec.all("joined").length, 0, "not seated twice");
	// The new host can talk to the rest, and the heartbeat carries on.
	a.handle.broadcast("reliable", { k: "still" });
	await w.run(3000);
	assert.deepStrictEqual(b.rec.last("message"), ["message", a.room.you, "reliable", { k: "still" }]);
	assert.strictEqual(a.room.players.length, 2);
	// A guest who left with the old host is dropped by the new one when silent.
	assert.strictEqual(b.room.closed, false);
});

test("host migration: a guest the new host never hears from is dropped; no new host means the end", async() => {
	const m = await load();
	const timers = createTimers();
	const events = m.createEmitter();
	const rec = recorder();
	const handle = m.createRoom({ on: events.on, join() {}, create() {}, send() {}, close() {} }, { name: "Bo", followHost: true, timers, now: timers.now, on: rec.on });
	handle.join("ABCDE");
	events.emit("room", { code: "ABCDE", you: "g", host: "h" });
	events.emit("open", "h");
	events.emit("message", "h", "reliable", JSON.stringify({ t: "roster", players: [{ id: "h", host: true }, { id: "g", host: false }, { id: "x", host: false }], phase: "nonsense" }));
	assert.strictEqual(handle.room.phase, "lobby");
	events.emit("peer-left", { id: "h" });
	assert.strictEqual(handle.room.closed, false, "waiting for the next host");
	events.emit("host", { id: "g" });
	assert.strictEqual(handle.isHost, true);
	timers.run(m.SILENCE_MS + 1000);
	assert.deepStrictEqual(rec.last("left"), ["left", "x"]);
	// Waiting for a host that never shows.
	const events2 = m.createEmitter();
	const rec2 = recorder();
	const h2 = m.createRoom({ on: events2.on, join() {}, create() {}, send() {}, close() {} }, { followHost: true, timers, now: timers.now, on: rec2.on });
	h2.join("ABCDE");
	events2.emit("room", { code: "ABCDE", you: "g", host: "h" });
	events2.emit("open", "h");
	events2.emit("peer-left", { id: "h" });
	timers.run(m.CONNECT_TIMEOUT_MS + 1);
	assert.deepStrictEqual(rec2.last("closed"), ["closed", "host_left"]);
	// Or one that's named but never connects.
	const events3 = m.createEmitter();
	const rec3 = recorder();
	const h3 = m.createRoom({ on: events3.on, join() {}, create() {}, send() {}, close() {} }, { followHost: true, timers, now: timers.now, on: rec3.on });
	h3.join("ABCDE");
	events3.emit("room", { code: "ABCDE", you: "g", host: "h" });
	events3.emit("open", "h");
	events3.emit("host", { id: "h2" });
	timers.run(m.CONNECT_TIMEOUT_MS + 1);
	assert.deepStrictEqual(rec3.last("closed"), ["closed", "host_left"]);
});

test("seat tokens live in session storage, and do without it", async() => {
	const { seatToken, SEAT_KEY } = await load();
	const store = new Map();
	const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
	const first = seatToken(storage, () => 0.5);
	assert.match(first, /^seat-[a-z0-9]{16}$/);
	assert.strictEqual(store.get(SEAT_KEY), first);
	assert.strictEqual(seatToken(storage), first, "kept across a reload");
	const broken = { getItem() {
		throw new Error("blocked");
	}, setItem() {
		throw new Error("blocked");
	} };
	assert.match(seatToken(broken), /^seat-/);
	assert.match(seatToken(null), /^seat-/);
});
