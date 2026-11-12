// A stand-in for the hub and WebRTC inside one browser: tabs (or e2e pages) of the same origin and
// browser profile find each other over a BroadcastChannel. It speaks the same transport interface
// as hub.js, so a game can't tell them apart (games pick it with `?net=local`).
//
// The page that creates a room plays the hub's part for it: it hands out the code, admits or turns
// away joiners, and says when they leave. Players only talk to the host, as in the star over
// WebRTC. Both channels (`reliable` and `fast`) are delivered in order and never dropped here
// (wrap it in netsim.js for a worse network).
//
// Like the hub, it promotes a new host when the host leaves: the host keeps every guest up to date
// on who's in the room (oldest first), and when it goes, the oldest remaining guest takes over and
// says so (`host`). With `followHost` the rest reconnect to it (host migration); without, they only
// hear the `host` event, as from the hub.
//
// Transport interface: create({maxPeers, meta}), join(code, meta), send(id, channel, data),
// leave(), close(), and on(event, fn) for room, peer-joined, peer-left, open (a peer's channels are
// ready), message (id, channel, data), host and error ({code, re}).
import { createEmitter } from "./emitter.js";
import { roomCode } from "./code.js";

export const LOCAL_CHANNEL = "spa-rtc-net";
// How long a join waits for a host to answer before giving up.
export const JOIN_TIMEOUT = 1500;

export function createLocalTransport({
	BroadcastChannel: Channel = globalThis.BroadcastChannel,
	rng = Math.random,
	channel = LOCAL_CHANNEL,
	followHost = false,
	timers = globalThis
} = {}) {
	const events = createEmitter();
	// Not from `rng`: two pages opened with the same ?seed= still need different ids.
	const id = `local-${Math.random().toString(36).slice(2, 10)}`;
	const bc = new Channel(channel);
	// The room this page hosts ({code, maxPeers, peers: Map id → meta}), or null.
	let hosted = null;
	// The room this page joined ({code, host, members: [id] oldest first, maxPeers}), or null.
	let joined = null;
	let joinTimer = null;

	const post = msg => bc.postMessage({ ...msg, from: id });
	const later = fn => Promise.resolve().then(fn);

	function stopJoinTimer() {
		if (joinTimer !== null) timers.clearTimeout(joinTimer);
		joinTimer = null;
	}

	// Every guest hears who's in the room, oldest first, so they all agree who's next in line.
	function sendMembers() {
		const members = [...hosted.peers.keys()].filter(pid => pid !== id);
		post({ k: "members", members, maxPeers: hosted.maxPeers });
	}

	function admit(msg) {
		// The host counts itself among the peers, as the hub does.
		if (hosted.peers.size >= hosted.maxPeers) {
			post({ k: "error", to: msg.from, code: "room_full", re: "join" });
			return;
		}
		const others = [...hosted.peers].filter(([pid]) => pid !== id).map(([pid, meta]) => ({ id: pid, meta }));
		hosted.peers.set(msg.from, msg.meta ?? null);
		post({ k: "room", to: msg.from, code: hosted.code, host: id, maxPeers: hosted.maxPeers, peers: others });
		sendMembers();
		events.emit("peer-joined", { id: msg.from, meta: msg.meta ?? null });
		events.emit("open", msg.from);
	}

	// Our host left: the oldest remaining guest takes over.
	function promote() {
		const was = joined;
		const oldHost = was.host;
		const members = was.members.filter(pid => pid !== oldHost);
		const next = members[0];
		events.emit("peer-left", { id: oldHost });
		// Hearing that may have closed this page's room (a room that doesn't follow hosts ends).
		if (joined !== was) return;
		if (!next) {
			joined = null;
			return;
		}
		if (next === id) {
			hosted = { code: was.code, maxPeers: was.maxPeers, peers: new Map([[id, null], ...members.filter(pid => pid !== id).map(pid => [pid, null])]) };
			joined = null;
			events.emit("host", { id });
			sendMembers();
		} else {
			joined.host = next;
			joined.members = members;
			events.emit("host", { id: next });
			if (followHost) post({ k: "rejoin", to: next });
		}
	}

	bc.onmessage = ({ data: msg }) => {
		if (!msg || msg.from === id || (msg.to !== undefined && msg.to !== id)) return;
		if (msg.k === "join") {
			if (hosted && msg.code === hosted.code) admit(msg);
		} else if (msg.k === "room" && joinTimer !== null) {
			stopJoinTimer();
			joined = { code: msg.code, host: msg.host, members: [id], maxPeers: msg.maxPeers };
			events.emit("room", { code: msg.code, you: id, host: msg.host, maxPeers: msg.maxPeers, peers: msg.peers, iceServers: [] });
			events.emit("open", msg.host);
		} else if (msg.k === "error" && joinTimer !== null) {
			stopJoinTimer();
			events.emit("error", { code: msg.code, re: msg.re });
		} else if (msg.k === "members") {
			if (joined && msg.from === joined.host) {
				joined.members = msg.members;
				joined.maxPeers = msg.maxPeers;
			}
		} else if (msg.k === "rejoin") {
			if (hosted && hosted.peers.has(msg.from)) {
				post({ k: "rejoined", to: msg.from });
				events.emit("open", msg.from);
			}
		} else if (msg.k === "rejoined") {
			if (joined && msg.from === joined.host) events.emit("open", msg.from);
		} else if (msg.k === "data") {
			if ((hosted && hosted.peers.has(msg.from)) || (joined && msg.from === joined.host)) events.emit("message", msg.from, msg.channel, msg.data);
		} else if (msg.k === "leave") {
			if (hosted && msg.from !== id && hosted.peers.delete(msg.from)) {
				sendMembers();
				events.emit("peer-left", { id: msg.from });
			}
			if (joined && msg.from === joined.host) promote();
			else if (joined) joined.members = joined.members.filter(pid => pid !== msg.from);
		}
	};

	function leave() {
		stopJoinTimer();
		if (hosted || joined) post({ k: "leave" });
		hosted = null;
		joined = null;
	}

	return {
		kind: "local",
		on: events.on,
		create({ maxPeers = 8, meta = null } = {}) {
			leave();
			hosted = { code: roomCode(rng), maxPeers, peers: new Map([[id, meta]]) };
			const room = { code: hosted.code, you: id, host: id, maxPeers, peers: [], iceServers: [] };
			later(() => events.emit("room", room));
		},
		join(code, meta = null) {
			leave();
			joinTimer = timers.setTimeout(() => {
				joinTimer = null;
				events.emit("error", { code: "no_such_room", re: "join" });
			}, JOIN_TIMEOUT);
			post({ k: "join", code: String(code || "").toUpperCase(), meta });
		},
		send(to, ch, data) {
			post({ k: "data", to, channel: ch, data });
		},
		leave,
		close() {
			leave();
			bc.close();
		}
	};
}
