// A multiplayer room on top of a transport (hub.js or local.js): who's in it, the lobby, a
// heartbeat that measures ping and notices silence, late joiners and players coming back, and a way
// to send the game's own messages. No gameplay here.
//
// The host's browser is authoritative and the room is a star: guests talk only to the host, and the
// host never relays between guests (the game does, if it wants to). If the host leaves, the room is
// over for everyone, unless `followHost` is on (and the transport follows too): then the hub's next
// host takes over the roster and the rest reconnect to it.
//
// Reliable-channel messages are JSON with a `t`:
//   guest → host: hello {name, profile, seat}, profile {name, profile} (changed in the lobby)
//   host → guests: roster {players, info, phase}, start {d} (the round began; re-sent to anyone who
//     joins mid-round, before the game hears of them)
//   both ways: ping/pong {ts}, msg {d} (the game's own messages, any JSON)
// The fast channel carries the game's strings or binary packets untouched.
//
// Seats: each page keeps a token for the tab (seatToken) and sends it with hello. A guest who drops
// and comes back with the same token (a reload, a lost connection and the link again) gets
// `joined(player, {rejoinOf: oldId})`, so the game can give them back their score, team or role.
// A token still held by a player the host hasn't noticed leaving yet drops that stale player first.
//
// `on` callbacks: update() when anything shown changes; message(from, channel, data) for the
// game's messages; start(data) on a guest when the round starts (or as it joins one under way);
// joined(player, {rejoinOf}) and left(id) on the host; hostChanged(id) after a migration;
// error(code) and closed(reason) when the room is over (reason: connect_failed, host_left, timeout,
// disconnected or a transport error code).
export const NAME_LIMIT = 32;
export const CONNECT_TIMEOUT_MS = 15000;
export const SILENCE_MS = 5000;
export const HEARTBEAT_MS = 1000;
// Where a tab keeps its seat token.
export const SEAT_KEY = "spa-rtc-seat";
// Seats of players who left, kept for them to come back to (the oldest go first).
export const KEEP_SEATS = 64;
export const PHASES = ["lobby", "playing"];

export const cleanName = text => String(text ?? "").slice(0, NAME_LIMIT);
const cleanSeat = seat => (typeof seat === "string" && seat.length > 0 && seat.length <= 64 ? seat : null);

// This tab's seat token: kept in sessionStorage, so a reload keeps it but another tab (or an e2e
// page in the same browser context) has its own. Without storage it's new each time.
export function seatToken(storage = globalThis.sessionStorage, rng = Math.random) {
	try {
		const kept = cleanSeat(storage && storage.getItem(SEAT_KEY));
		if (kept) return kept;
	} catch {
		// Storage can throw (private mode, blocked site data): a fresh token will do.
	}
	let token = "seat-";
	for (let i = 0; i < 16; i++) token += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rng() * 36)];
	try {
		if (storage) storage.setItem(SEAT_KEY, token);
	} catch {
		// As above.
	}
	return token;
}

// What a page shows of the room: {net, room, players, ping} as strings for data-* attributes.
// net is off, connecting, host, guest or closed.
export function describeRoom(room) {
	if (!room) return { net: "off", room: "", players: "0", ping: "" };
	let net = "connecting";
	if (room.closed) net = "closed";
	else if (room.connected) net = room.role;
	return {
		net,
		room: room.code || "",
		players: String(room.players.length),
		ping: room.ping === null ? "" : String(Math.round(room.ping))
	};
}

export function createRoom(transport, {
	name: startName = "",
	profile: startProfile = null,
	cleanProfile = p => p ?? null,
	seat = null,
	followHost = false,
	connectTimeoutMs = CONNECT_TIMEOUT_MS,
	silenceMs = SILENCE_MS,
	heartbeatMs = HEARTBEAT_MS,
	timers = globalThis,
	now = () => Date.now(),
	on = {}
} = {}) {
	let name = cleanName(startName);
	let profile = cleanProfile(startProfile);
	const mySeat = cleanSeat(seat);
	const call = (fn, ...args) => {
		if (on[fn]) on[fn](...args);
	};
	const room = {
		role: null,
		code: null,
		you: null,
		hostId: null,
		// [{id, name, host, profile}], the host first.
		players: [],
		// Whatever the host wants guests to see in the lobby.
		info: null,
		// "lobby" or "playing" (between start() and stop()).
		phase: "lobby",
		// The round's start message (the host's last start(data)), while it plays.
		startData: null,
		connected: false,
		// Lost the signaling server after connecting: players already in carry on, nobody new joins.
		offline: false,
		closed: false,
		closeReason: null,
		// Round-trip time in ms: a guest's to the host, the host's worst among its guests; null until measured.
		ping: null
	};
	const isHost = () => room.role === "host";
	// When each connected peer was last heard from, and the last round trip to each.
	const heard = new Map();
	const pings = new Map();
	// Host: the seat each player in the room holds (id → token), and the seats of those who left
	// (token → id), oldest first.
	const seatOf = new Map();
	const departed = new Map();
	let connectTimer = null;
	let beat = null;

	const control = (to, msg) => transport.send(to, "reliable", JSON.stringify(msg));
	const guests = () => room.players.filter(p => !p.host).map(p => p.id);
	const isGuest = id => room.players.some(p => p.id === id && !p.host);

	function stopConnectTimer() {
		if (connectTimer !== null) timers.clearTimeout(connectTimer);
		connectTimer = null;
	}

	function stopTimers() {
		stopConnectTimer();
		if (beat !== null) timers.clearInterval(beat);
		beat = null;
	}

	// Gives up with `reason` unless connected (to the host) within the connect timeout.
	function waitForConnection(reason) {
		stopConnectTimer();
		if (!connectTimeoutMs) return;
		connectTimer = timers.setTimeout(() => {
			connectTimer = null;
			if (!room.connected) end(reason, true);
		}, connectTimeoutMs);
	}

	function connected() {
		room.connected = true;
		stopConnectTimer();
		if (beat === null && heartbeatMs) {
			beat = timers.setInterval(tick, heartbeatMs);
			tick();
		}
	}

	function end(reason, isError = false) {
		if (room.closed) return;
		room.closed = true;
		room.closeReason = reason;
		stopTimers();
		transport.close();
		if (isError) call("error", reason);
		call("closed", reason);
		call("update");
	}

	function updatePing() {
		const values = [...pings.values()];
		room.ping = values.length ? Math.max(...values) : null;
	}

	function forget(id) {
		heard.delete(id);
		pings.delete(id);
		updatePing();
	}

	function keepSeat(id) {
		const token = seatOf.get(id);
		seatOf.delete(id);
		if (!token) return;
		departed.delete(token);
		departed.set(token, id);
		while (departed.size > KEEP_SEATS) departed.delete(departed.keys().next().value);
	}

	function dropGuest(id) {
		forget(id);
		if (!isGuest(id)) return;
		room.players = room.players.filter(p => p.id !== id);
		keepSeat(id);
		sendRoster();
		call("left", id);
	}

	// Every heartbeat: ping everyone we're connected to, then give up on anyone who has gone quiet.
	function tick() {
		const t = now();
		const targets = isHost() ? [...heard.keys()] : [room.hostId];
		for (const id of targets) if (id !== null && heard.has(id)) control(id, { t: "ping", ts: t });
		if (!silenceMs) return;
		for (const [id, at] of [...heard]) {
			if (t - at <= silenceMs) continue;
			if (isHost()) dropGuest(id);
			else if (id === room.hostId) end("timeout");
		}
	}

	function sendRoster() {
		const text = JSON.stringify({ t: "roster", players: room.players, info: room.info, phase: room.phase });
		for (const id of guests()) transport.send(id, "reliable", text);
		call("update");
	}

	function hello() {
		control(room.hostId, { t: "hello", name, profile, seat: mySeat });
	}

	transport.on("room", msg => {
		if (room.closed) return;
		room.code = msg.code;
		room.you = msg.you;
		room.hostId = msg.host;
		room.role = msg.you === msg.host ? "host" : "guest";
		if (isHost()) {
			room.players = [{ id: msg.you, name, host: true, profile }];
			connected();
		}
		call("update");
	});

	transport.on("open", id => {
		if (room.closed) return;
		if (isHost()) {
			heard.set(id, now());
		} else if (id === room.hostId) {
			heard.set(id, now());
			hello();
			connected();
			call("update");
		}
	});

	transport.on("peer-left", ({ id }) => {
		if (room.closed) return;
		if (isHost()) {
			dropGuest(id);
		} else if (id === room.hostId) {
			if (!followHost) {
				end("host_left");
				return;
			}
			// Wait for the hub to name the next host; give up if it doesn't.
			forget(id);
			room.connected = false;
			waitForConnection("host_left");
			call("update");
		}
	});

	// The hub picked a new host because ours left.
	transport.on("host", ({ id }) => {
		if (room.closed || id === room.hostId) return;
		if (!followHost) {
			if (!isHost()) end("host_left");
			return;
		}
		migrate(id);
	});

	// Host migration: the new host takes over the roster (minus the old host) and gives everyone
	// else the silence timeout to reconnect; the rest dial it and say hello again.
	function migrate(id) {
		const oldHost = room.hostId;
		room.hostId = id;
		forget(oldHost);
		if (id === room.you) {
			room.role = "host";
			const me = { id: room.you, name, host: true, profile };
			const others = room.players.filter(p => p.id !== oldHost && p.id !== room.you).map(p => ({ ...p, host: false }));
			room.players = [me, ...others];
			const t = now();
			for (const p of others) heard.set(p.id, t);
			connected();
			call("hostChanged", id);
			sendRoster();
		} else {
			room.connected = false;
			waitForConnection("host_left");
			call("hostChanged", id);
			call("update");
		}
	}

	// A peer that couldn't connect only matters to a guest (it was the host); a host just never
	// sees that player arrive.
	transport.on("error", ({ code, peer }) => {
		if (room.closed || (peer !== undefined && isHost())) return;
		if (room.connected) call("error", code);
		else end(code, true);
	});

	// The signaling server went away. Before we're connected that's the end of it; after, players
	// already connected carry on, but nobody new can join.
	transport.on("offline", () => {
		if (room.closed) return;
		if (!room.connected) {
			end("disconnected", true);
			return;
		}
		room.offline = true;
		call("update");
	});

	transport.on("message", (from, channel, data) => {
		if (room.closed || !heard.has(from)) return;
		heard.set(from, now());
		if (channel === "fast") {
			if (known(from)) call("message", from, "fast", data);
			return;
		}
		if (typeof data !== "string") return;
		let msg = null;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;
		if (msg.t === "ping") {
			control(from, { t: "pong", ts: msg.ts });
		} else if (msg.t === "pong") {
			if (typeof msg.ts !== "number") return;
			pings.set(from, Math.max(0, now() - msg.ts));
			updatePing();
			call("update");
		} else if (isHost()) {
			onHostMessage(from, msg);
		} else if (from === room.hostId) {
			onGuestMessage(msg);
		}
	});

	// The host takes game messages only from seated guests, a guest only from the host.
	const known = from => (isHost() ? isGuest(from) : from === room.hostId);

	function onHostMessage(from, msg) {
		if (msg.t === "hello") {
			onHello(from, msg);
		} else if (msg.t === "profile") {
			// Once the round is on, its players are already seated with what they had.
			const player = room.players.find(p => p.id === from && !p.host);
			if (!player || room.phase === "playing") return;
			player.name = cleanName(msg.name);
			player.profile = cleanProfile(msg.profile);
			sendRoster();
		} else if (msg.t === "msg") {
			if (isGuest(from)) call("message", from, "reliable", msg.d);
		}
	}

	function onHello(from, msg) {
		const seatToken = cleanSeat(msg.seat);
		const already = room.players.find(p => p.id === from);
		if (already) {
			// Saying hello again (after a migration): brought up to date, not seated twice.
			if (already.host) return;
			if (seatToken) seatOf.set(from, seatToken);
			sendRoster();
			if (room.startData !== null) control(from, { t: "start", d: room.startData });
			return;
		}
		let rejoinOf = null;
		if (seatToken) {
			const stale = [...seatOf].find(([, token]) => token === seatToken);
			if (stale) {
				rejoinOf = stale[0];
				dropGuest(rejoinOf);
			}
			if (departed.has(seatToken)) {
				rejoinOf = departed.get(seatToken);
				departed.delete(seatToken);
			}
		}
		const player = { id: from, name: cleanName(msg.name), host: false, profile: cleanProfile(msg.profile) };
		room.players.push(player);
		if (seatToken) seatOf.set(from, seatToken);
		sendRoster();
		if (room.startData !== null) control(from, { t: "start", d: room.startData });
		call("joined", player, { rejoinOf });
	}

	function onGuestMessage(msg) {
		if (msg.t === "roster") {
			room.players = Array.isArray(msg.players) ? msg.players : [];
			room.info = msg.info ?? null;
			room.phase = PHASES.includes(msg.phase) ? msg.phase : "lobby";
			if (room.phase === "lobby") room.startData = null;
			call("update");
		} else if (msg.t === "start") {
			room.phase = "playing";
			room.startData = msg.d ?? null;
			call("start", room.startData);
			call("update");
		} else if (msg.t === "msg") {
			call("message", room.hostId, "reliable", msg.d);
		}
	}

	const wrap = (channel, data) => (channel === "reliable" ? JSON.stringify({ t: "msg", d: data }) : data);

	return {
		room,
		get isHost() {
			return isHost();
		},
		// The seat token this page sends (null for none).
		seat: mySeat,
		host(maxPlayers = 8, info = null) {
			room.info = info;
			waitForConnection("connect_failed");
			transport.create({ maxPeers: maxPlayers, meta: { name } });
		},
		join(code) {
			waitForConnection("connect_failed");
			transport.join(code, { name });
		},
		// Host: what the lobby shows guests.
		setInfo(info) {
			room.info = info;
			if (isHost() && !room.closed) sendRoster();
		},
		// Your name or profile changed in the lobby: the roster shows it (a guest asks the host).
		setProfile(next = {}) {
			const nextName = next.name === undefined ? name : cleanName(next.name);
			const nextProfile = next.profile === undefined ? profile : cleanProfile(next.profile);
			if (nextName === name && JSON.stringify(nextProfile) === JSON.stringify(profile)) return;
			name = nextName;
			profile = nextProfile;
			if (room.closed) return;
			if (isHost()) {
				const me = room.players.find(p => p.id === room.you);
				if (!me) return;
				me.name = name;
				me.profile = profile;
				sendRoster();
			} else if (room.connected) {
				control(room.hostId, { t: "profile", name, profile });
			}
		},
		// Host: start (or restart) the round for everyone. `data` (any JSON) also goes to anyone who
		// joins while it plays, before the game hears they joined.
		start(data = null) {
			if (!isHost() || room.closed) return;
			room.phase = "playing";
			room.startData = data;
			const text = JSON.stringify({ t: "start", d: data });
			for (const id of guests()) transport.send(id, "reliable", text);
			call("update");
		},
		// Host: the round is over; back to the lobby (newcomers are only seated in the roster).
		stop() {
			if (!isHost() || room.closed) return;
			room.phase = "lobby";
			room.startData = null;
			sendRoster();
		},
		// Host: a game message to one guest. Strings and binary packets go as they are on the fast
		// channel; on the reliable one the data is JSON.
		sendTo(id, channel, data) {
			if (!isHost() || room.closed || !isGuest(id)) return;
			transport.send(id, channel, wrap(channel, data));
		},
		// Host: the same to every guest.
		broadcast(channel, data) {
			if (!isHost() || room.closed) return;
			const out = wrap(channel, data);
			for (const id of guests()) transport.send(id, channel, out);
		},
		// Guest: a game message to the host.
		sendToHost(channel, data) {
			if (isHost() || room.closed || !room.connected) return;
			transport.send(room.hostId, channel, wrap(channel, data));
		},
		leave() {
			if (room.closed) return;
			room.closed = true;
			room.closeReason = "left";
			stopTimers();
			transport.close();
			call("update");
		}
	};
}
