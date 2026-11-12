// A bad network on demand, for trying the netcode: `?netsim=latency,jitter,loss` (milliseconds,
// milliseconds, percent; e.g. ?netsim=80,20,5) wraps the transport so every message, in and out,
// is held for latency ± jitter, and that share of `fast` messages is dropped. `reliable` messages
// are never dropped and stay in order, as on a real reliable channel.

// {latency, jitter, loss} in seconds and a 0–1 share, or null for no simulation.
export function parseNetsim(text) {
	if (!text) return null;
	const [lat, jit, loss] = String(text).split(",").map(Number);
	if (![lat, jit ?? 0, loss ?? 0].every(n => Number.isFinite(n) && n >= 0)) return null;
	return { latency: lat / 1000, jitter: (jit || 0) / 1000, loss: Math.min(1, (loss || 0) / 100) };
}

export function withNetsim(transport, sim, { rng = Math.random, timers = globalThis, now = () => Date.now() / 1000 } = {}) {
	if (!sim) return transport;
	const handlers = [];
	// The last delivery time per peer and direction on the reliable channel, to keep it in order.
	const lastReliable = new Map();

	function delay(peer, channel, dir, fn) {
		if (channel === "fast" && rng() < sim.loss) return;
		let at = now() + sim.latency + (rng() * 2 - 1) * sim.jitter;
		if (channel !== "fast") {
			const k = `${dir}:${peer}`;
			at = Math.max(at, lastReliable.get(k) || 0);
			lastReliable.set(k, at);
		}
		timers.setTimeout(fn, Math.max(0, (at - now()) * 1000));
	}

	transport.on("message", (from, channel, data) => {
		delay(from, channel, "in", () => {
			for (const fn of handlers) fn(from, channel, data);
		});
	});

	return {
		...transport,
		on(name, fn) {
			if (name === "message") handlers.push(fn);
			else transport.on(name, fn);
		},
		send(to, channel, data) {
			delay(to, channel, "out", () => transport.send(to, channel, data));
		}
	};
}
