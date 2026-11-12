// Lag compensation, the Source way: the host keeps where every body stood over the last second,
// and when a guest's shot (or any action aimed at others) arrives it puts the targets back where
// that guest saw them (their render time, interpolated like the guest's view) before tracing it.
// What you hit on your screen is what you hit.
import { blendPose } from "./lerp.js";

// Seconds of history kept.
export const HISTORY = 1;
// The furthest back a shot is rewound (seconds behind the host's present). Past this, a player on
// a very slow link shoots at slightly stale positions rather than far into the past.
export const MAX_UNLAG = 0.5;

export function createHistory({ keep = HISTORY, maxUnlag = MAX_UNLAG } = {}) {
	return { frames: [], keep, maxUnlag };
}

// Notes every body's pose (a Map key → pose) at host time `time`. Call once per host frame, after
// the world moved. A frame at the same time (or earlier) as the last replaces it.
export function record(history, time, poses) {
	const frames = history.frames;
	while (frames.length && frames[frames.length - 1].time >= time) frames.pop();
	frames.push({ time, poses });
	while (frames.length > 2 && frames[1].time < time - history.keep) frames.shift();
}

// A function key → the pose that body had at time `t` (no further back than maxUnlag behind
// `now`), blended between the frames either side by `blend` (lerp.js's blendPose by default), or
// null if it wasn't there (or there's no history).
export function posesAt(history, t, now, { blend = blendPose } = {}) {
	const frames = history.frames;
	if (!frames.length) return () => null;
	const when = Math.max(t, now - history.maxUnlag);
	let i = frames.length - 1;
	while (i > 0 && frames[i - 1].time >= when) i--;
	const b = frames[i];
	const a = i > 0 ? frames[i - 1] : b;
	const span = b.time - a.time;
	const f = span > 0 ? Math.min(1, Math.max(0, (when - a.time) / span)) : 1;
	return key => {
		const pb = b.poses.get(key);
		const pa = a.poses.get(key);
		if (pa && pb) return blend(pa, pb, f);
		return pb || pa || null;
	};
}
