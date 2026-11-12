"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { seq } = require("./support");

const load = async() => ({
	...(await import("../src/netsim.js")),
	...(await import("../src/emitter.js"))
});

test("netsim settings are read from the URL value", async() => {
	const n = await load();
	assert.strictEqual(n.parseNetsim(""), null);
	assert.strictEqual(n.parseNetsim("x"), null);
	assert.strictEqual(n.parseNetsim("-5"), null);
	assert.deepStrictEqual(n.parseNetsim("80,20,5"), { latency: 0.08, jitter: 0.02, loss: 0.05 });
	assert.deepStrictEqual(n.parseNetsim("100"), { latency: 0.1, jitter: 0, loss: 0 });
	assert.strictEqual(n.parseNetsim("0,0,500").loss, 1);
});

test("netsim delays both ways, drops only fast messages and keeps reliable ones in order", async() => {
	const n = await load();
	const events = n.createEmitter();
	const sent = [];
	const base = { kind: "x", on: events.on, send: (...a) => sent.push(a), create: () => "created" };
	assert.strictEqual(n.withNetsim(base, null), base, "no simulation: the transport itself");
	let clock = 0;
	const due = [];
	const timers = { setTimeout: (fn, ms) => due.push({ at: clock + ms / 1000, fn }) };
	const advance = t => {
		clock = t;
		due.sort((a, b) => a.at - b.at);
		while (due.length && due[0].at <= clock + 1e-9) due.shift().fn();
	};
	// Jitter draws: the first reliable message gets the most delay, the second the least.
	const rng = seq(1, 0, 0, 0.9, 0.5);
	const t = n.withNetsim(base, { latency: 0.1, jitter: 0.05, loss: 0.5 }, { rng, timers, now: () => clock });
	assert.strictEqual(t.kind, "x");
	assert.strictEqual(t.create(), "created");
	const got = [];
	const opened = [];
	t.on("message", (...a) => got.push(a));
	t.on("open", id => opened.push(id));
	events.emit("open", "p");
	assert.deepStrictEqual(opened, ["p"], "other events pass straight through");
	t.send("p", "reliable", "a");
	t.send("p", "reliable", "b");
	advance(0.06);
	assert.deepStrictEqual(sent, []);
	advance(0.2);
	assert.deepStrictEqual(sent.map(s => s[2]), ["a", "b"], "still in order though b drew less delay");
	// Fast: the first is dropped (0 < loss), the second delivered.
	events.emit("message", "p", "fast", "lost");
	events.emit("message", "p", "fast", "kept");
	advance(0.5);
	assert.deepStrictEqual(got, [["p", "fast", "kept"]]);
});
