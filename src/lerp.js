// Blending between two moments, for interpolation (snapbuf.js) and rewinding (lagcomp.js).
const TAU = Math.PI * 2;

export const lerp = (a, b, t) => a + (b - a) * t;

// The short way round between two angles (radians).
export function lerpAngle(a, b, t) {
	let d = (b - a) % TAU;
	if (d > Math.PI) d -= TAU;
	if (d < -Math.PI) d += TAU;
	return a + d * t;
}

const isVec = v => v !== null && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.z);

// {x, y, z} (y optional) between two points.
export function lerpVec(a, b, t) {
	if (Number.isFinite(a.y) && Number.isFinite(b.y)) return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
	return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) };
}

// Two poses (plain objects) blended at `t` (0 is `a`, 1 is `b`): numbers are interpolated (the keys
// in `angles` the short way round), points ({x, y, z}) too, and everything else, or any key in
// `snap`, is taken from the nearer of the two.
export function blendPose(a, b, t, { angles = ["yaw"], snap = [] } = {}) {
	const near = t < 0.5 ? a : b;
	const out = { ...near };
	for (const key of Object.keys(out)) {
		if (snap.includes(key) || !(key in a) || !(key in b)) continue;
		const va = a[key];
		const vb = b[key];
		if (typeof va === "number" && typeof vb === "number" && Number.isFinite(va) && Number.isFinite(vb)) {
			out[key] = angles.includes(key) ? lerpAngle(va, vb, t) : lerp(va, vb, t);
		} else if (isVec(va) && isVec(vb)) {
			out[key] = lerpVec(va, vb, t);
		}
	}
	return out;
}
