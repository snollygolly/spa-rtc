"use strict";

// Shared helpers for the tests: a fake clock, an in-memory BroadcastChannel, a scripted rng.

// setTimeout / setInterval on a clock that only moves when run(ms) says so. `now()` is that clock
// in milliseconds.
function createTimers() {
	let t = 0;
	let next = 1;
	const jobs = new Map();
	const timers = {
		now: () => t,
		setTimeout(fn, ms = 0) {
			const id = next++;
			jobs.set(id, { at: t + Math.max(0, ms), fn, every: 0 });
			return id;
		},
		setInterval(fn, ms) {
			const id = next++;
			jobs.set(id, { at: t + ms, fn, every: Math.max(1, ms) });
			return id;
		},
		clearTimeout(id) {
			jobs.delete(id);
		},
		clearInterval(id) {
			jobs.delete(id);
		},
		get pending() {
			return jobs.size;
		},
		// Moves the clock on by `ms`, running every job that falls due, in time order.
		run(ms) {
			const end = t + ms;
			for (;;) {
				let due = null;
				for (const [id, job] of jobs) if (job.at <= end && (!due || job.at < due[1].at || (job.at === due[1].at && id < due[0]))) due = [id, job];
				if (!due) break;
				const [id, job] = due;
				t = Math.max(t, job.at);
				if (job.every) job.at += job.every;
				else jobs.delete(id);
				job.fn();
			}
			t = end;
		}
	};
	return timers;
}

// A BroadcastChannel stand-in: every channel of the same name hears the others' messages
// (structured-cloned, never its own), delivered later, as a real one does.
function createBus() {
	const queue = [];
	const open = new Set();
	class Channel {
		constructor(name) {
			this.name = name;
			this.onmessage = null;
			open.add(this);
		}

		postMessage(data) {
			for (const ch of open) if (ch !== this && ch.name === this.name) queue.push([ch, structuredClone(data)]);
		}

		close() {
			open.delete(this);
		}
	}
	return {
		Channel,
		// Delivers everything posted, including what that posts, then lets promises run.
		async settle() {
			for (let round = 0; round < 50; round++) {
				await new Promise(r => setImmediate(r));
				if (!queue.length) return;
				while (queue.length) {
					const [ch, data] = queue.shift();
					if (open.has(ch) && ch.onmessage) ch.onmessage({ data });
				}
			}
			throw new Error("bus never settled");
		},
		// Delivers what is queued now, synchronously (for tests on a fake clock).
		flush() {
			let n = 0;
			while (queue.length) {
				if (++n > 100000) throw new Error("bus never settled");
				const [ch, data] = queue.shift();
				if (open.has(ch) && ch.onmessage) ch.onmessage({ data });
			}
		}
	};
}

// An rng that plays these values in turn, over and over.
const seq = (...values) => {
	let i = 0;
	return () => values[i++ % values.length];
};

module.exports = { createTimers, createBus, seq };
