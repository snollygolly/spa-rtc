// The host's side of the netcode (a listen server), for whatever a game's commands and snapshots are.
//   - Command gates: each guest's commands run in order, once each, as they arrive (Quake 3's
//     ClientThink), within a time budget that grows with real time, so a guest can't move faster
//     by sending more or longer commands (Source's sv_maxusrcmdprocessticks).
//   - Snapshots: each guest gets deltas against the newest snapshot it has acknowledged, and the
//     last BACKUP sent are kept as possible baselines (Quake 3's PACKET_BACKUP).
import { seqNewer } from "./bytes.js";

export const BACKUP = 32;
// Seconds of commands a guest may bank (covers a burst after a stall, not a speed hack).
export const MAX_BUDGET = 0.25;

// One guest's gate: the last command it ran and how much time it may still spend.
export function createCmdGate({ maxBudget = MAX_BUDGET, seqBits = null } = {}) {
	return { lastSeq: 0, budget: maxBudget / 2, maxBudget, seqBits };
}

// The commands in a packet to run now: newer than the last one run, oldest first, each paid for
// out of the budget (`msecOf(cmd)`, milliseconds). One over budget is dropped, not delayed: the
// guest's prediction is corrected by the next snapshot.
export function admitCmds(gate, cmds, msecOf = c => c.msec) {
	const newer = (a, b) => (gate.seqBits ? seqNewer(a, b, gate.seqBits) : a > b);
	const sorted = [...cmds].sort((a, b) => {
		if (a.seq === b.seq) return 0;
		return newer(a.seq, b.seq) ? 1 : -1;
	});
	const out = [];
	for (const cmd of sorted) {
		if (!newer(cmd.seq, gate.lastSeq)) continue;
		gate.lastSeq = cmd.seq;
		const cost = Math.max(0, msecOf(cmd)) / 1000;
		if (cost > gate.budget) continue;
		gate.budget -= cost;
		out.push(cmd);
	}
	return out;
}

// Real time passed on the host: every gate's budget refills by it.
export function refillGate(gate, dt) {
	gate.budget = Math.min(gate.maxBudget, gate.budget + dt);
}

// A new round: commands start over.
export function resetGate(gate) {
	gate.lastSeq = 0;
	gate.budget = gate.maxBudget / 2;
}

// Per-guest snapshot baselines. next() starts a snapshot tick; for each guest, baseFor(id) is the
// state to delta against (null: send it whole), keep(id, state) remembers what was sent, and
// ack(id, tick) records the newest tick the guest says it has.
export function createSnapshots({ backup = BACKUP } = {}) {
	const guests = new Map();
	let tick = 0;
	return {
		guests,
		get tick() {
			return tick;
		},
		add(id) {
			guests.set(id, { id, ackTick: 0, sent: new Map(), bytesOut: 0 });
		},
		remove(id) {
			guests.delete(id);
		},
		has(id) {
			return guests.has(id);
		},
		// A new round: ticks and baselines start over.
		reset() {
			tick = 0;
			for (const g of guests.values()) {
				g.ackTick = 0;
				g.sent.clear();
			}
		},
		ack(id, ackTick) {
			const g = guests.get(id);
			if (g && ackTick <= tick && ackTick > g.ackTick) g.ackTick = ackTick;
		},
		next() {
			tick++;
			return tick;
		},
		baseFor(id) {
			const g = guests.get(id);
			return (g && g.sent.get(g.ackTick)) || null;
		},
		keep(id, state, bytes = 0) {
			const g = guests.get(id);
			if (!g) return;
			g.sent.set(tick, state);
			g.sent.delete(tick - backup);
			g.bytesOut += bytes;
		}
	};
}
