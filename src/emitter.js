// A tiny event emitter for the transports and the room: on(name, fn) and emit(name, ...args).
export function createEmitter() {
	const handlers = new Map();
	return {
		on(name, fn) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(fn);
		},
		emit(name, ...args) {
			for (const fn of handlers.get(name) || []) fn(...args);
		}
	};
}
