// The guest's side of snapshots: which ones are worth using, the ones kept as baselines for the
// host's deltas, and the numbers for a net graph.
import { BACKUP } from "./server.js";

// Snapshots arrive on the unordered fast channel: accept(tick) is true only for one newer than any
// before (counting the ones skipped as lost), keep(state) remembers it as a baseline the host may
// delta against, get(tick) finds one. `lastTick` is what to acknowledge. Ticks don't wrap (send
// them as u32), and when the host starts its ticks over (createSnapshots' reset, a new round) call
// reset() here too, or every snapshot is turned away until the ticks pass the old ones.
export function createReceiver({ backup = BACKUP, stats = null } = {}) {
	const states = new Map();
	let lastTick = 0;
	return {
		get lastTick() {
			return lastTick;
		},
		accept(tick) {
			if (tick <= lastTick) return false;
			if (stats && lastTick) stats.lost(tick - lastTick - 1);
			if (stats) stats.got();
			lastTick = tick;
			return true;
		},
		keep(tick, state) {
			states.set(tick, state);
			for (const t of [...states.keys()]) if (t <= tick - backup) states.delete(t);
		},
		get(tick) {
			return states.get(tick);
		},
		// A new round: ticks start over.
		reset() {
			states.clear();
			lastTick = 0;
		}
	};
}

// Bytes in and out per second and the share of snapshots lost, over the last WINDOW seconds.
export const WINDOW = 1;

export function createNetStats() {
	const counts = { bytesIn: 0, bytesOut: 0, got: 0, missed: 0, t: 0 };
	const stats = {
		loss: 0,
		inRate: 0,
		outRate: 0,
		sent(bytes) {
			counts.bytesOut += bytes;
		},
		received(bytes) {
			counts.bytesIn += bytes;
		},
		got() {
			counts.got++;
		},
		lost(n) {
			counts.missed += Math.max(0, n);
		},
		// Call once a frame.
		frame(dt) {
			counts.t += dt;
			if (counts.t < WINDOW) return;
			stats.inRate = counts.bytesIn / counts.t;
			stats.outRate = counts.bytesOut / counts.t;
			stats.loss = counts.got + counts.missed ? counts.missed / (counts.got + counts.missed) : 0;
			Object.assign(counts, { bytesIn: 0, bytesOut: 0, got: 0, missed: 0, t: 0 });
		}
	};
	return stats;
}
