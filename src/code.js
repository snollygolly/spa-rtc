// Room codes, in the format the game hub hands out: 5 characters from an alphabet without the
// look-alikes (no 0/O, 1/I). The hub makes real codes; roomCode is for the in-browser transport.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

export function roomCode(rng) {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
	return code;
}

// A typed room code, tidied (spaces and dashes dropped, upper case), or null if it isn't one.
export function parseRoomCode(text) {
	const code = String(text ?? "").replace(/[\s-]/g, "").toUpperCase();
	if (code.length !== CODE_LENGTH) return null;
	return [...code].every(c => CODE_ALPHABET.includes(c)) ? code : null;
}
