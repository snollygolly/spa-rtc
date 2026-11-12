# CLAUDE.md

**spa-rtc** is the shared multiplayer netcode for the studio's static browser games on spa-hub (fps-lab, night-shift, fairway-enough). See README.md for the modules and the room's API. Games pin it as a git dependency by tag, so a fix here reaches a game only after a new tag and a bump in that game.

- Plain ES modules in `src/` (`src/package.json` sets `"type": "module"`), no runtime dependencies, no DOM or three.js. Browser APIs (WebSocket, RTCPeerConnection, BroadcastChannel, timers, storage, clocks) are always injectable so `node --test` can drive everything.
- Nothing game-specific belongs here: no weapons, maps, roles or message vocabularies. A game's command contents, snapshot schema and rules stay in the game.
- Backwards compatibility matters: games upgrade one at a time. A breaking change to an export or to the room's wire messages needs a major version and a note in the README.
- Tests: `node --test` (CommonJS test files importing the ESM sources), one file per area, plus `test/scenarios.test.js`, the whole stack on a fake clock (`test/support.js`: `createTimers`, `createBus`). Every bug found in a game gets a scenario or unit test here. Coverage thresholds are 90% lines/functions, 85% branches.
- Lint: ESLint (`eslint.config.cjs`), tabs, double quotes, semicolons.

## Cardinal rules

1. **No new dependencies.** This package has none at runtime and should stay that way.
2. **Never run `npm install`** or any install command; that's the human's job.
3. **Network access is limited to documentation.**
4. **Never push or tag without the human's go-ahead.** Games depend on tags.
5. **Every fix comes with a test.**
