"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const load = () => import("../src/hub.js");

// Fakes for the browser's WebSocket and RTCPeerConnection, driven by hand.
function fakes() {
	const sockets = [];
	const pcs = [];
	class FakeSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.sent = [];
			sockets.push(this);
		}

		send(text) {
			this.sent.push(JSON.parse(text));
		}

		close() {
			this.readyState = 3;
		}

		// Test helpers.
		open() {
			this.readyState = 1;
			this.onopen();
		}

		hub(msg) {
			this.onmessage({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
		}
	}
	class FakeChannel {
		constructor(label, opts) {
			this.label = label;
			this.opts = opts;
			this.readyState = "connecting";
			this.sent = [];
		}

		send(data) {
			this.sent.push(data);
		}

		open() {
			this.readyState = "open";
			this.onopen();
		}
	}
	class FakePC {
		constructor(config) {
			this.config = config;
			this.channels = [];
			this.candidates = [];
			this.localDescription = null;
			this.remoteDescription = null;
			this.closed = false;
			pcs.push(this);
		}

		createDataChannel(label, opts) {
			const ch = new FakeChannel(label, opts);
			this.channels.push(ch);
			return ch;
		}

		setLocalDescription() {
			this.localDescription = { type: this.remoteDescription ? "answer" : "offer", sdp: "local" };
			return Promise.resolve();
		}

		setRemoteDescription(d) {
			this.remoteDescription = d;
			return Promise.resolve();
		}

		addIceCandidate(c) {
			this.candidates.push(c);
			return Promise.resolve();
		}

		setConfiguration(config) {
			this.config = config;
		}

		close() {
			this.closed = true;
		}
	}
	const timers = {
		fns: new Map(),
		next: 1,
		setTimeout(fn) {
			const id = this.next++;
			this.fns.set(id, fn);
			return id;
		},
		clearTimeout(id) {
			this.fns.delete(id);
		},
		fire() {
			const fns = [...this.fns.values()];
			this.fns.clear();
			for (const fn of fns) fn();
		}
	};
	return { sockets, pcs, FakeSocket, FakePC, FakeChannel, timers };
}

const flush = () => new Promise(r => setTimeout(r, 0));

function record(t) {
	const log = [];
	for (const name of ["room", "peer-joined", "peer-left", "open", "message", "host", "error", "offline"]) t.on(name, (...a) => log.push([name, ...a]));
	return log;
}

test("the signaling URL is on the page's own host", async() => {
	const h = await load();
	assert.strictEqual(h.hubUrl({ protocol: "https:", host: "game.evilmousestudios.com" }), "wss://game.evilmousestudios.com/.hub/rtc");
	assert.strictEqual(h.hubUrl({ protocol: "http:", host: "game.localhost:3100" }), "ws://game.localhost:3100/.hub/rtc");
});

test("a guest joins, dials the host and opens both channels", async() => {
	const h = await load();
	const f = fakes();
	const t = h.createHubTransport({ url: "ws://x/.hub/rtc", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers });
	const log = record(t);
	t.send("nobody", "fast", "dropped");
	t.join("ABCDE", { name: "Bo" });
	const ws = f.sockets[0];
	assert.strictEqual(ws.url, "ws://x/.hub/rtc");
	assert.deepStrictEqual(ws.sent, [], "waits for the socket to open");
	ws.open();
	assert.deepStrictEqual(ws.sent, [{ t: "join", code: "ABCDE", meta: { name: "Bo" } }]);
	ws.hub("not json");
	ws.hub({ t: "hello", you: "g", turn: true });
	const ice = [{ urls: "turn:x" }];
	ws.hub({ t: "room", code: "ABCDE", you: "g", host: "h", maxPeers: 4, peers: [{ id: "h" }], iceServers: ice });
	assert.strictEqual(log[0][0], "room");
	const pc = f.pcs[0];
	assert.deepStrictEqual(pc.config, { iceServers: ice });
	assert.deepStrictEqual(pc.channels.map(c => [c.label, c.opts]), [["reliable", {}], ["fast", { ordered: false, maxRetransmits: 0 }]]);
	await pc.onnegotiationneeded();
	assert.deepStrictEqual(ws.sent.at(-1), { t: "signal", to: "h", data: { description: { type: "offer", sdp: "local" } } });
	pc.onicecandidate({ candidate: null });
	pc.onicecandidate({ candidate: { c: 1 } });
	assert.deepStrictEqual(ws.sent.at(-1), { t: "signal", to: "h", data: { candidate: { c: 1 } } });
	// A candidate from the host before its answer waits for the answer.
	ws.hub({ t: "signal", from: "h", data: { candidate: { c: 2 } } });
	await flush();
	assert.deepStrictEqual(pc.candidates, []);
	ws.hub({ t: "signal", from: "h", data: { description: { type: "answer", sdp: "remote" } } });
	await flush();
	assert.deepStrictEqual(pc.candidates, [{ c: 2 }]);
	ws.hub({ t: "signal", from: "h", data: { candidate: { c: 3 } } });
	await flush();
	assert.deepStrictEqual(pc.candidates, [{ c: 2 }, { c: 3 }]);
	// Open once both channels are.
	pc.channels[0].open();
	assert.ok(!log.some(e => e[0] === "open"));
	pc.channels[1].open();
	assert.deepStrictEqual(log.at(-1), ["open", "h"]);
	pc.channels[0].onopen();
	assert.strictEqual(log.filter(e => e[0] === "open").length, 1);
	t.send("h", "fast", "input");
	assert.deepStrictEqual(pc.channels[1].sent, ["input"]);
	pc.channels[0].onmessage({ data: "roster" });
	assert.deepStrictEqual(log.at(-1), ["message", "h", "reliable", "roster"]);
	ws.hub({ t: "host", id: "g" });
	assert.deepStrictEqual(log.at(-1), ["host", { id: "g" }]);
	// TURN credentials are refreshed before they run out.
	f.timers.fire();
	assert.deepStrictEqual(ws.sent.at(-1), { t: "ice" });
	ws.hub({ t: "ice", iceServers: [{ urls: "turn:y" }] });
	assert.deepStrictEqual(pc.config, { iceServers: [{ urls: "turn:y" }] });
	ws.hub({ t: "ice" });
	assert.deepStrictEqual(pc.config, { iceServers: [{ urls: "turn:y" }] });
	ws.hub({ t: "error", code: "rate_limited", re: "ice" });
	assert.deepStrictEqual(log.at(-1), ["error", { code: "rate_limited", re: "ice" }]);
	// A channel closing means the peer's gone.
	pc.channels[0].onclose();
	assert.deepStrictEqual(log.at(-1), ["peer-left", { id: "h" }]);
	assert.strictEqual(pc.closed, true);
	t.send("h", "fast", "lost");
	assert.deepStrictEqual(pc.channels[1].sent, ["input"]);
	t.close();
	assert.deepStrictEqual(ws.sent.at(-1), { t: "leave" });
	assert.strictEqual(ws.readyState, 3);
	t.close();
});

test("a host answers offers, takes the guest's channels and hears them leave", async() => {
	const h = await load();
	const f = fakes();
	const t = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, relayOnly: true, timers: f.timers });
	const log = record(t);
	t.create({ maxPeers: 3, meta: { name: "Ann" } });
	const ws = f.sockets[0];
	ws.open();
	assert.deepStrictEqual(ws.sent, [{ t: "create", maxPeers: 3, meta: { name: "Ann" } }]);
	ws.hub({ t: "room", code: "ABCDE", you: "h", host: "h", maxPeers: 3, peers: [] });
	assert.strictEqual(f.pcs.length, 0, "the host waits to be dialled");
	ws.hub({ t: "peer-joined", id: "g", meta: { name: "Bo" } });
	assert.deepStrictEqual(log.at(-1), ["peer-joined", { id: "g", meta: { name: "Bo" } }]);
	ws.hub({ t: "signal", from: "g", data: { description: { type: "offer", sdp: "o" } } });
	await flush();
	const pc = f.pcs[0];
	assert.deepStrictEqual(pc.config, { iceServers: [], iceTransportPolicy: "relay" });
	assert.deepStrictEqual(ws.sent.at(-1), { t: "signal", to: "g", data: { description: { type: "answer", sdp: "local" } } });
	ws.hub({ t: "signal", from: "g" });
	await flush();
	const reliable = new f.FakeChannel("reliable", {});
	const fast = new f.FakeChannel("fast", {});
	const stray = new f.FakeChannel("other", {});
	pc.ondatachannel({ channel: stray });
	assert.strictEqual(stray.onmessage, undefined, "unknown channels are left alone");
	reliable.readyState = "open";
	pc.ondatachannel({ channel: reliable });
	pc.ondatachannel({ channel: fast });
	fast.open();
	assert.deepStrictEqual(log.at(-1), ["open", "g"]);
	assert.strictEqual(fast.binaryType, "arraybuffer");
	ws.hub({ t: "peer-left", id: "g" });
	assert.deepStrictEqual(log.at(-1), ["peer-left", { id: "g" }]);
	assert.strictEqual(pc.closed, true);
	// Closing a channel of a peer already gone says nothing more.
	reliable.onclose();
	assert.deepStrictEqual(log.at(-1), ["peer-left", { id: "g" }]);
	ws.hub({ t: "peer-left", id: "nobody" });
	// The socket dropping leaves connections as they are and says the room is offline.
	ws.onclose();
	assert.deepStrictEqual(log.at(-1), ["offline"]);
	ws.onerror();
	// A later create opens a new socket.
	t.create({ maxPeers: 2 });
	assert.strictEqual(f.sockets.length, 2);
	t.leave();
	t.close();
});

test("ICE failing: a playing peer has left, one that never connected couldn't", async() => {
	const h = await load();
	const f = fakes();
	const t = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers });
	const log = record(t);
	t.join("ABCDE");
	const ws = f.sockets[0];
	ws.open();
	ws.hub({ t: "room", code: "ABCDE", you: "g", host: "h", maxPeers: 2, peers: [] });
	const pc = f.pcs[0];
	pc.connectionState = "checking";
	pc.onconnectionstatechange();
	assert.strictEqual(pc.closed, false);
	pc.connectionState = "failed";
	pc.onconnectionstatechange();
	assert.deepStrictEqual(log.at(-1), ["error", { code: "connect_failed", peer: "h" }]);
	assert.strictEqual(pc.closed, true);
	pc.onconnectionstatechange();
	assert.strictEqual(log.filter(e => e[0] === "error").length, 1, "once");
	// A host whose guest drops after playing hears it left.
	const t2 = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers });
	const log2 = record(t2);
	t2.create();
	const ws2 = f.sockets[1];
	ws2.open();
	ws2.hub({ t: "room", code: "ABCDE", you: "h", host: "h", maxPeers: 2, peers: [] });
	ws2.hub({ t: "signal", from: "g", data: { description: { type: "offer", sdp: "o" } } });
	await flush();
	const pc2 = f.pcs[1];
	for (const label of ["reliable", "fast"]) {
		const ch = new f.FakeChannel(label, {});
		ch.readyState = "open";
		pc2.ondatachannel({ channel: ch });
	}
	assert.deepStrictEqual(log2.at(-1), ["open", "g"]);
	pc2.connectionState = "failed";
	pc2.onconnectionstatechange();
	assert.deepStrictEqual(log2.at(-1), ["peer-left", { id: "g" }]);
});

test("by default a guest only hears of a new host; with followHost it dials it", async() => {
	const h = await load();
	const f = fakes();
	const plain = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers });
	const plainLog = record(plain);
	plain.join("ABCDE");
	f.sockets[0].open();
	f.sockets[0].hub({ t: "room", code: "ABCDE", you: "g", host: "h", maxPeers: 4, peers: [] });
	assert.strictEqual(f.pcs.length, 1);
	f.sockets[0].hub({ t: "host", id: "g2" });
	assert.deepStrictEqual(plainLog.at(-1), ["host", { id: "g2" }]);
	assert.strictEqual(f.pcs.length, 1, "no new connection");
	assert.strictEqual(f.pcs[0].closed, false);

	const follow = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers, followHost: true });
	const log = record(follow);
	follow.join("ABCDE");
	const ws = f.sockets[1];
	ws.open();
	ws.hub({ t: "room", code: "ABCDE", you: "g", host: "h", maxPeers: 4, peers: [] });
	const old = f.pcs[1];
	ws.hub({ t: "host", id: "g2" });
	assert.strictEqual(old.closed, true, "the old host's connection is dropped");
	assert.strictEqual(f.pcs.length, 3, "and the new host dialled");
	assert.deepStrictEqual(f.pcs[2].channels.map(c => c.label), ["reliable", "fast"]);
	assert.deepStrictEqual(log.at(-1), ["host", { id: "g2" }]);
	// The same host again changes nothing; becoming the host yourself dials nobody.
	ws.hub({ t: "host", id: "g2" });
	assert.strictEqual(f.pcs.length, 3);
	ws.hub({ t: "host", id: "g" });
	assert.strictEqual(f.pcs.length, 3);
	assert.deepStrictEqual(log.at(-1), ["host", { id: "g" }]);
});

test("losing the signaling socket says offline; peers already connected stay", async() => {
	const h = await load();
	const f = fakes();
	const t = h.createHubTransport({ url: "ws://x", WebSocket: f.FakeSocket, RTCPeerConnection: f.FakePC, timers: f.timers });
	const log = record(t);
	t.create({ maxPeers: 4, meta: { name: "Ann" } });
	const ws = f.sockets[0];
	ws.open();
	assert.deepStrictEqual(ws.sent, [{ t: "create", maxPeers: 4, meta: { name: "Ann" } }]);
	ws.hub({ t: "room", code: "ABCDE", you: "h", host: "h", maxPeers: 4, peers: [] });
	ws.onclose();
	assert.deepStrictEqual(log.at(-1), ["offline"]);
	assert.strictEqual(f.timers.fns.size, 0, "no TURN refresh without a socket");
});
