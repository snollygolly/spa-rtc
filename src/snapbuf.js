// Entity interpolation, as in Source: a guest draws other bodies a little in the past (INTERP),
// between the two snapshots either side of that moment, so they move smoothly however unevenly
// packets arrive. If packets stop, bodies carry on along their last motion for at most
// EXTRAPOLATE, then hold.
//
// The host's clock is estimated from snapshot times against the guest's own and nudged towards
// each new sample rather than jumping (Quake 3's CL_AdjustTimeDelta), unless it's way off.
//
// Times are seconds on any clock, as long as the host's and the guest's each only go forward.
import { blendPose } from "./lerp.js";

export const INTERP = 0.1;
export const EXTRAPOLATE = 0.05;
// A clock sample this far from the estimate resets it (a stall, a new round).
export const RESYNC = 0.5;
// How far each sample pulls the estimate.
export const CLOCK_PULL = 0.1;
// Snapshots kept for interpolation.
export const KEEP = 32;

export function createClock() {
	return { offset: null };
}

export function clockSample(clock, serverTime, localTime) {
	const sample = serverTime - localTime;
	if (clock.offset === null || Math.abs(sample - clock.offset) > RESYNC) clock.offset = sample;
	else clock.offset += (sample - clock.offset) * CLOCK_PULL;
}

// The host's present on the guest's clock; 0 until the first sample. A host drawing its own guests
// through a buffer is its own server: clockSample(clock, t, t) once, or use its own time.
export function serverNow(clock, localTime) {
	return clock.offset === null ? 0 : localTime + clock.offset;
}

// When to draw others: the host's present less the interpolation delay (never below 0).
export function renderTime(clock, localTime, delay = INTERP) {
	return Math.max(0, serverNow(clock, localTime) - delay);
}

export function createBuffer({ keep = KEEP } = {}) {
	return { frames: [], keep };
}

// Adds a snapshot's entities (a Map key → entity) at host time `time`.
export function pushFrame(buf, time, ents) {
	const frames = buf.frames;
	if (frames.length && time <= frames[frames.length - 1].time) {
		// A new round (time went back) starts over; a late duplicate is ignored.
		if (time < frames[frames.length - 1].time - RESYNC) frames.length = 0;
		else return;
	}
	frames.push({ time, ents });
	if (frames.length > buf.keep) frames.shift();
}

// Every entity's pose at host time `t`, as a list. `pose(entity)` turns what was stored into a pose
// (dequantizes it), `blend(a, b, f)` mixes two (lerp.js's blendPose by default). Entities only in
// the newer snapshot appear as they are there; ones gone from it stay until `t` passes it.
export function sample(buf, t, { pose = e => e, blend = blendPose, extrapolate = EXTRAPOLATE } = {}) {
	const frames = buf.frames;
	if (!frames.length) return [];
	if (frames.length === 1) return [...frames[0].ents.values()].map(pose);
	let i = 1;
	while (i < frames.length && frames[i].time < t) i++;
	if (i >= frames.length) i = frames.length - 1;
	const a = frames[i - 1];
	const b = frames[i];
	const span = b.time - a.time;
	const until = Math.min(t, frames[frames.length - 1].time + extrapolate);
	// Before the oldest frame: hold it. Past the newest: carry on a little, then hold.
	const f = span > 0 ? Math.max(0, (until - a.time) / span) : 1;
	const out = [];
	for (const [k, eb] of b.ents) {
		const ea = a.ents.get(k);
		const pb = pose(eb);
		out.push(ea ? blend(pose(ea), pb, f) : pb);
	}
	if (f < 1) for (const [k, ea] of a.ents) if (!b.ents.has(k)) out.push(pose(ea));
	return out;
}
