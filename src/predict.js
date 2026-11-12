// Client-side prediction and reconciliation, the Quake 3 / Source way, for whatever a game's
// commands do:
//   - Every frame becomes commands (cmdLengths cuts real time into whole milliseconds) that the
//     game runs on its own player at once and sends to the host, the last few together in each
//     packet (recent) so a lost one costs nothing.
//   - When a snapshot says what the host made of them (the last command it ran, `ackSeq`), the
//     game resets its player to the host's state, and the commands the host hasn't run yet run
//     again (reconcile). The gap between where the player was drawn and where that puts it is eased
//     out over `smooth` seconds (Source's prediction error smoothing) as an offset the game adds when
//     drawing; a big one (a respawn, a teleport) snaps.
// The game keeps its own state; the predictor only needs to be told how to reset, run and measure.
import { seqNewer } from "./bytes.js";

// Errors bigger than this (in the game's units, metres say) snap instead of easing out.
export const SNAP_DIST = 2;
// Seconds over which an error is eased out.
export const SMOOTH = 0.1;
// Commands kept waiting for the host (two seconds at 60 fps).
export const MAX_PENDING = 128;
// The longest command (ms); a long frame becomes several.
export const MAX_MSEC = 50;
// How far each round trip pulls the ping estimate.
const PING_PULL = 0.1;

// A frame of `ms` milliseconds as whole-millisecond command lengths, each at most `maxMsec`; the
// fraction left over is kept in `carry` ({ms}) for the next frame.
export function cmdLengths(ms, carry, maxMsec = MAX_MSEC) {
	const total = ms + carry.ms;
	let whole = Math.floor(total);
	carry.ms = total - whole;
	const out = [];
	while (whole > 0) {
		const n = Math.min(maxMsec, whole);
		out.push(n);
		whole -= n;
	}
	return out;
}

// `seqBits`: commands' sequence numbers wrap at 2^seqBits (as the game's codec sends them), or
// never with null.
export function createPredictor({ maxPending = MAX_PENDING, snapDist = SNAP_DIST, smooth = SMOOTH, seqBits = null } = {}) {
	const newer = (a, b) => (seqBits ? seqNewer(a, b, seqBits) : a > b);
	const sentAt = new Map();
	const offset = { x: 0, y: 0, z: 0 };
	let seq = 0;
	let pending = [];
	let ping = null;

	return {
		// The predicted view's offset while an error is eased out (add it when drawing).
		offset,
		// Round-trip time (ms) from commands to the snapshot that acknowledged them; null until known.
		get ping() {
			return ping;
		},
		get seq() {
			return seq;
		},
		get pending() {
			return pending;
		},
		// Numbers `cmd` (cmd.seq), keeps it until the host has run it, and returns it. `localTime`
		// is seconds on the guest's clock.
		issue(cmd, localTime) {
			seq = seqBits ? (seq + 1) % (2 ** seqBits) : seq + 1;
			cmd.seq = seq;
			pending.push(cmd);
			sentAt.set(seq, localTime);
			if (pending.length > maxPending) {
				const dropped = pending.slice(0, pending.length - maxPending);
				pending = pending.slice(-maxPending);
				for (const c of dropped) sentAt.delete(c.seq);
			}
			return cmd;
		},
		// The last `n` commands, to send together.
		recent(n) {
			return pending.slice(-n);
		},
		// The host has run every command up to `ackSeq`. `game.reset()` puts the player back to the
		// host's state (from the same snapshot), `game.run(cmd)` runs a command again, and
		// `game.position()` says where the player is ({x, y, z}; missing axes count as 0). `snap` forces a snap
		// (a respawn, say). Returns {error, snapped}: how far the player moved.
		reconcile(ackSeq, localTime, game, snap = false) {
			const before = { ...game.position() };
			game.reset();
			pending = pending.filter(c => newer(c.seq, ackSeq));
			const sent = sentAt.get(ackSeq);
			if (sent !== undefined) {
				const rtt = (localTime - sent) * 1000;
				ping = ping === null ? rtt : ping + (rtt - ping) * PING_PULL;
			}
			for (const s of [...sentAt.keys()]) if (!newer(s, ackSeq)) sentAt.delete(s);
			for (const cmd of pending) game.run(cmd);
			const after = game.position();
			const d = key => (Number(before[key]) || 0) - (Number(after[key]) || 0);
			const err = { x: d("x"), y: d("y"), z: d("z") };
			const total = { x: offset.x + err.x, y: offset.y + err.y, z: offset.z + err.z };
			const snapped = snap || Math.hypot(total.x, total.y, total.z) > snapDist;
			if (snapped) Object.assign(offset, { x: 0, y: 0, z: 0 });
			else Object.assign(offset, total);
			return { error: Math.hypot(err.x, err.y, err.z), snapped };
		},
		// Eases the offset out; call once a frame.
		decay(dt) {
			const k = Math.exp(-dt / smooth);
			offset.x *= k;
			offset.y *= k;
			offset.z *= k;
		},
		// A new round: nothing pending, no offset (the sequence carries on).
		reset() {
			pending = [];
			sentAt.clear();
			Object.assign(offset, { x: 0, y: 0, z: 0 });
		}
	};
}
