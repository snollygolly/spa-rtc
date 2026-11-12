"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createBus, createTimers } = require("./support");

const load = () => import("../src/local.js");

function record(t) {
	const log = [];
	for (const name of ["room", "peer-joined", "peer-left", "open", "message", "host", "error"]) t.on(name, (...a) => log.push([name, ...a]));
	return log;
}

test("a host makes a room, a guest joins it, and they talk", async() => {
	const { createLocalTransport } = await load();
	const bus = createBus();
	const timers = createTimers();
	const host = createLocalTransport({ BroadcastChannel: bus.Channel, rng: () => 0.5, timers });
	const guest = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const h = record(host);
	const g = record(guest);
	host.create({ maxPeers: 2, meta: { name: "Ann" } });
	await bus.settle();
	const room = h.find(e => e[0] === "room")[1];
	assert.match(room.code, /^[A-Z2-9]{5}$/);
	assert.strictEqual(room.you, room.host);
	guest.join(room.code.toLowerCase(), { name: "Bo" });
	await bus.settle();
	const joined = g.find(e => e[0] === "room")[1];
	assert.strictEqual(joined.host, room.you);
	assert.deepStrictEqual(g.at(-1), ["open", room.you]);
	assert.deepStrictEqual(h.slice(-2), [["peer-joined", { id: joined.you, meta: { name: "Bo" } }], ["open", joined.you]]);
	guest.send(room.you, "fast", "hi");
	host.send(joined.you, "reliable", "yo");
	await bus.settle();
	assert.deepStrictEqual(h.at(-1), ["message", joined.you, "fast", "hi"]);
	assert.deepStrictEqual(g.at(-1), ["message", room.you, "reliable", "yo"]);
	// A third page is turned away from a full room.
	const late = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const l = record(late);
	late.join(room.code);
	await bus.settle();
	assert.deepStrictEqual(l.at(-1), ["error", { code: "room_full", re: "join" }]);
	// The guest leaving is heard by the host.
	guest.close();
	await bus.settle();
	assert.deepStrictEqual(h.at(-1), ["peer-left", { id: joined.you }]);
	host.close();
});

test("joining a room nobody hosts gives up", async() => {
	const { createLocalTransport, JOIN_TIMEOUT } = await load();
	const bus = createBus();
	const timers = createTimers();
	const t = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const log = record(t);
	t.join("ZZZZZ");
	await bus.settle();
	timers.run(JOIN_TIMEOUT);
	assert.deepStrictEqual(log.at(-1), ["error", { code: "no_such_room", re: "join" }]);
});

test("when the host leaves the oldest guest is promoted; followers reconnect to it", async() => {
	const { createLocalTransport } = await load();
	const bus = createBus();
	const timers = createTimers();
	const host = createLocalTransport({ BroadcastChannel: bus.Channel, timers, followHost: true });
	const a = createLocalTransport({ BroadcastChannel: bus.Channel, timers, followHost: true });
	const b = createLocalTransport({ BroadcastChannel: bus.Channel, timers, followHost: true });
	const h = record(host);
	const la = record(a);
	const lb = record(b);
	host.create({ maxPeers: 4 });
	await bus.settle();
	const code = h[0][1].code;
	a.join(code);
	await bus.settle();
	b.join(code);
	await bus.settle();
	const idA = la.find(e => e[0] === "room")[1].you;
	const idB = lb.find(e => e[0] === "room")[1].you;
	const hostId = h[0][1].you;
	host.close();
	await bus.settle();
	assert.ok(la.some(e => e[0] === "peer-left" && e[1].id === hostId));
	assert.deepStrictEqual(la.find(e => e[0] === "host"), ["host", { id: idA }], "the oldest guest takes over");
	assert.deepStrictEqual(lb.find(e => e[0] === "host"), ["host", { id: idA }]);
	assert.deepStrictEqual(lb.at(-1), ["open", idA], "the other guest is back in touch");
	assert.deepStrictEqual(la.at(-1), ["open", idB]);
	b.send(idA, "fast", "still here");
	await bus.settle();
	assert.deepStrictEqual(la.at(-1), ["message", idB, "fast", "still here"]);
	// The new host leaving too leaves the last guest alone, promoted to host of an empty room.
	a.close();
	await bus.settle();
	assert.deepStrictEqual(lb.filter(e => e[0] === "host").at(-1), ["host", { id: idB }]);
});

test("without followHost a guest hears of the new host but doesn't reconnect", async() => {
	const { createLocalTransport } = await load();
	const bus = createBus();
	const timers = createTimers();
	const host = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const a = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const b = createLocalTransport({ BroadcastChannel: bus.Channel, timers });
	const h = record(host);
	const lb = record(b);
	record(a);
	host.create();
	await bus.settle();
	a.join(h[0][1].code);
	await bus.settle();
	b.join(h[0][1].code);
	await bus.settle();
	const opens = lb.filter(e => e[0] === "open").length;
	host.close();
	await bus.settle();
	assert.ok(lb.some(e => e[0] === "host"));
	assert.strictEqual(lb.filter(e => e[0] === "open").length, opens);
	// Messages from strangers are ignored.
	b.send("nobody", "fast", "x");
	await bus.settle();
});
