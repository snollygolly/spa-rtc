# spa-rtc

Peer-to-peer multiplayer for static browser games published on **spa-hub**. The games have no backend. The hub's `/.hub/rtc` does the signaling and TURN, and from then on the game's traffic goes straight between browsers over WebRTC data channels.

It started as FPS Lab's netcode (modelled on Quake 3 and Source), merged with Night Shift's heartbeat and Fairway Enough's host migration. One copy, tested once, used by every game.

Plain ES modules with no dependencies. Every browser API is passed in, so `node --test` drives all of it.

## Using it

Add it as a pinned git dependency, then run `npm install`:

```json
"devDependencies": {
  "spa-rtc": "github:snollygolly/spa-rtc#v1.0.0"
}
```

Import the modules by path:

```js
import { createHubTransport, hubUrl } from "spa-rtc/hub";
import { createLocalTransport } from "spa-rtc/local";
import { parseNetsim, withNetsim } from "spa-rtc/netsim";
import { createRoom, describeRoom, seatToken } from "spa-rtc/room";
```

To fix a bug for every game: fix it here, add a test, tag a release (`v1.0.1`), then bump the tag in each game.

## The layers

| module | what it does |
| --- | --- |
| `hub` | The real transport. It speaks spa-hub's signaling and runs one `RTCPeerConnection` per peer with two channels: `reliable` (ordered) and `fast` (unordered, no retransmits). The layout is a star round the host. TURN credentials are refreshed. If the signaling socket drops, the transport emits `offline` and connections already made carry on. `followHost` re-dials the hub's next host when the host leaves. |
| `local` | The same interface over a `BroadcastChannel` between tabs of one browser, for e2e (`?net=local`). The hosting tab plays the hub's part, including promoting the next host. Pass `channel` per game. |
| `netsim` | `?netsim=latency,jitter,loss` wraps any transport in a worse network. |
| `room` | Who's in the room, the lobby (`info`, profiles), the round's `phase`, a heartbeat (ping, plus silence and connect timeouts), late join, seat reclaim, optional host migration, and an envelope for the game's own messages. |
| `code` | Room codes in the hub's format (`roomCode`, `parseRoomCode`). |
| `bytes` | `Writer` / `Reader` over a DataView, quantizers, `seqNewer` for wrapping sequence numbers, `decode` (junk becomes null), and `entityCodec`, which writes delta entities against a baseline. |
| `predict` | Client-side prediction: `cmdLengths`, then a predictor that numbers commands, sends the last few again in each packet, reconciles against the host's ack, and eases errors out as a draw offset. |
| `server` | Host side: command gates (in order, once each, within a time budget) and per-guest snapshot baselines with acks. |
| `client` | Guest side: `createReceiver` (newest snapshots only, baselines kept, loss counted) and `createNetStats` for a net graph. |
| `snapbuf` | Interpolation 100 ms in the past, brief extrapolation, and the host-clock estimate. |
| `lagcomp` | One second of pose history, rewound to the time a guest fired at (capped at `MAX_UNLAG`). |
| `lerp` | `blendPose`, which interpolates numbers and points, takes angles the short way, and takes everything else from the nearer pose. |

Your game keeps its own command contents, snapshot schema, rules and message meanings.

## The room

```js
const room = createRoom(transport, {
  name, profile,                 // what the roster shows; profile is any JSON
  cleanProfile: p => …,          // the host checks what guests send
  seat: seatToken(),             // per tab, survives a reload
  followHost: false,             // true = host migration (the transport needs it too)
  connectTimeoutMs, silenceMs, heartbeatMs,   // 15 s, 5 s, 1 s; 0 turns one off
  on: { update, message, start, joined, left, hostChanged, error, closed }
});
room.host(maxPlayers, info);  room.join(code);
room.setInfo(info);  room.setProfile({ name, profile });
room.start(data);  room.stop();           // host: round on / back to the lobby
room.sendTo(id, channel, data);  room.broadcast(channel, data);  room.sendToHost(channel, data);
room.leave();
```

- **Late join.** A guest who joins while a round is on receives the roster first, then the round's `start` data, before the host's `joined(player)` runs. Anything the host sends from `joined` (the current score, a full state) arrives after that.
- **Rejoin.** A guest who comes back with the same seat token (after a reload, a dropped link or a closed tab) gets `joined(player, { rejoinOf: oldId })`, so the game can hand back their score, team or role. If the host hasn't yet noticed the old connection drop, the stale player is removed first (`left(oldId)`).
- **Silence.** The host drops a guest it hasn't heard from in `silenceMs`. A guest gives up on a silent host with `closed("timeout")`.
- **Host leaving.** The room closes with `closed("host_left")`, unless `followHost` is on: then the oldest guest becomes host (`hostChanged`), keeps the roster and the round, and the rest reconnect and are brought up to date.
- **Messages.** Use `reliable` for JSON and `fast` for strings or binary, as is. The host only accepts game messages from seated guests, and a guest only from its host.

## Tests

`npm test` runs lint and unit tests. `npm run test:coverage` adds coverage, with thresholds of 90% lines/functions and 85% branches.

`test/scenarios.test.js` runs the whole stack on a fake clock with a seeded RNG. A host and guests on an in-memory bus, each guest behind netsim, play a toy game built on the sync kit. The scenarios cover:

- prediction converging exactly under 100 ms ± 30 ms and 20% loss, with every delta snapshot read back as sent
- rejoining mid-round with the score kept
- a dead link dropped after the silence timeout, then reclaimed
- the host leaving, with and without migration

Add a scenario there for any bug found in a game.
