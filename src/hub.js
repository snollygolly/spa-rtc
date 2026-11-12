// Multiplayer over the game hub (spa-hub): its signaling socket at /.hub/rtc matches players into
// rooms by code and relays WebRTC offers, answers and ICE candidates, then game traffic goes
// straight between browsers over data channels (or through the hub's TURN relay when a NAT is in
// the way). See spa-hub's README, "Multiplayer (WebRTC)".
//
// The layout is a host-authoritative star: everyone connects only to the host. Newcomers make the
// offer. Each connection has two channels: `reliable` (ordered, for the lobby and events) and
// `fast` (unordered, no retransmits, for inputs and snapshots, where late is worse than lost).
//
// Same interface as local.js, plus an `offline` event when the signaling socket closes. The
// browser APIs are passed in so tests can fake them.
//
// When the host leaves, the hub promotes the oldest guest and says so (`host`). By default that's
// all: the room (room.js) ends the match. With `followHost`, every guest also drops what's left of
// its old connections and dials the new host, so the star re-forms round it (host migration).
import { createEmitter } from "./emitter.js";

export const CHANNELS = {
	reliable: {},
	fast: { ordered: false, maxRetransmits: 0 }
};
// Ask for fresh TURN credentials this long after the last ones (the hub's default lifetime is 4 h).
export const ICE_REFRESH_MS = 3 * 60 * 60 * 1000;

// The signaling URL on the page's own host.
export function hubUrl(location) {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/.hub/rtc`;
}

export function createHubTransport({ url, WebSocket: Socket = globalThis.WebSocket, RTCPeerConnection: PeerConnection = globalThis.RTCPeerConnection, relayOnly = false, followHost = false, timers = globalThis }) {
	const events = createEmitter();
	let ws = null;
	let queue = [];
	let me = null;
	let host = null;
	let iceServers = [];
	let iceTimer = null;
	// Peer id → {pc, channels: {reliable, fast}, chain, candidates, open}.
	const peers = new Map();

	function sendWs(msg) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
		else queue.push(msg);
	}

	function connect() {
		if (ws) return;
		ws = new Socket(url);
		ws.onopen = () => {
			const pending = queue;
			queue = [];
			for (const msg of pending) sendWs(msg);
		};
		ws.onmessage = ({ data }) => {
			let msg = null;
			try {
				msg = JSON.parse(data);
			} catch {
				return;
			}
			onSignal(msg);
		};
		ws.onerror = () => {};
		// Losing the signaling socket (the hub redeploying, say) doesn't end connections already
		// made: those players play on, but nobody new can join, so the room hears it's offline.
		ws.onclose = () => {
			ws = null;
			queue = [];
			if (iceTimer !== null) timers.clearTimeout(iceTimer);
			iceTimer = null;
			events.emit("offline");
		};
	}

	function scheduleIce() {
		if (iceTimer !== null) timers.clearTimeout(iceTimer);
		iceTimer = timers.setTimeout(() => {
			iceTimer = null;
			sendWs({ t: "ice" });
		}, ICE_REFRESH_MS);
	}

	function onSignal(msg) {
		if (msg.t === "room") {
			me = msg.you;
			host = msg.host;
			iceServers = msg.iceServers || [];
			scheduleIce();
			events.emit("room", msg);
			if (me !== host) dial(host, true);
		} else if (msg.t === "peer-joined") {
			events.emit("peer-joined", { id: msg.id, meta: msg.meta });
		} else if (msg.t === "peer-left") {
			drop(msg.id);
			events.emit("peer-left", { id: msg.id });
		} else if (msg.t === "host") {
			const changed = host !== msg.id;
			host = msg.id;
			if (followHost && changed && me !== host) {
				dropAll();
				dial(host, true);
			}
			events.emit("host", { id: msg.id });
		} else if (msg.t === "signal") {
			const peer = peers.get(msg.from) || dial(msg.from, false);
			peer.chain = peer.chain.then(() => onPeerSignal(msg.from, peer, msg.data || {})).catch(() => {});
		} else if (msg.t === "ice") {
			iceServers = msg.iceServers || iceServers;
			scheduleIce();
			for (const { pc } of peers.values()) if (pc.setConfiguration) pc.setConfiguration(config());
		} else if (msg.t === "error") {
			events.emit("error", { code: msg.code, re: msg.re });
		}
	}

	async function onPeerSignal(id, peer, { description, candidate }) {
		const { pc } = peer;
		if (description) {
			await pc.setRemoteDescription(description);
			// Candidates that came in before the description can go in now.
			for (const c of peer.candidates.splice(0)) await pc.addIceCandidate(c);
			if (description.type === "offer") {
				await pc.setLocalDescription();
				sendWs({ t: "signal", to: id, data: { description: pc.localDescription } });
			}
		} else if (candidate) {
			if (pc.remoteDescription) await pc.addIceCandidate(candidate);
			else peer.candidates.push(candidate);
		}
	}

	function config() {
		return relayOnly ? { iceServers, iceTransportPolicy: "relay" } : { iceServers };
	}

	function dial(id, offerer) {
		const pc = new PeerConnection(config());
		const peer = { pc, channels: {}, chain: Promise.resolve(), candidates: [], open: false };
		peers.set(id, peer);
		pc.onicecandidate = e => {
			if (e.candidate) sendWs({ t: "signal", to: id, data: { candidate: e.candidate } });
		};
		const wire = ch => {
			if (!CHANNELS[ch.label]) return;
			ch.binaryType = "arraybuffer";
			peer.channels[ch.label] = ch;
			ch.onmessage = e => events.emit("message", id, ch.label, e.data);
			ch.onopen = () => checkOpen(id, peer);
			ch.onclose = () => {
				if (peers.get(id) === peer && peer.open) {
					drop(id);
					events.emit("peer-left", { id });
				}
			};
			checkOpen(id, peer);
		};
		pc.ondatachannel = e => wire(e.channel);
		// ICE gave up: a peer that was playing has gone; one that never got through couldn't connect.
		pc.onconnectionstatechange = () => {
			if (pc.connectionState !== "failed" || peers.get(id) !== peer) return;
			drop(id);
			if (peer.open) events.emit("peer-left", { id });
			else events.emit("error", { code: "connect_failed", peer: id });
		};
		if (offerer) {
			for (const [label, opts] of Object.entries(CHANNELS)) wire(pc.createDataChannel(label, opts));
			pc.onnegotiationneeded = async() => {
				await pc.setLocalDescription();
				sendWs({ t: "signal", to: id, data: { description: pc.localDescription } });
			};
		}
		return peer;
	}

	// A peer counts as open once both its channels are.
	function checkOpen(id, peer) {
		if (peer.open) return;
		if (!Object.keys(CHANNELS).every(label => peer.channels[label] && peer.channels[label].readyState === "open")) return;
		peer.open = true;
		events.emit("open", id);
	}

	function drop(id) {
		const peer = peers.get(id);
		if (!peer) return;
		peers.delete(id);
		peer.pc.close();
	}

	function dropAll() {
		for (const id of [...peers.keys()]) drop(id);
	}

	function leave() {
		if (iceTimer !== null) timers.clearTimeout(iceTimer);
		iceTimer = null;
		dropAll();
		if (me !== null) sendWs({ t: "leave" });
		me = null;
		host = null;
	}

	return {
		kind: "hub",
		on: events.on,
		create({ maxPeers = 8, meta = null } = {}) {
			connect();
			sendWs({ t: "create", maxPeers, meta });
		},
		join(code, meta = null) {
			connect();
			sendWs({ t: "join", code, meta });
		},
		send(to, label, data) {
			const peer = peers.get(to);
			const ch = peer && peer.channels[label];
			if (ch && ch.readyState === "open") ch.send(data);
		},
		leave,
		close() {
			leave();
			if (ws) {
				ws.onclose = null;
				ws.close();
				ws = null;
			}
		}
	};
}
