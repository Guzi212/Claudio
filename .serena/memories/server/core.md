# server/

Entry `server/app.js`: `hostGuard` → `express.json({limit:'1mb'})` → static `pwa/` → `authMiddleware` → `mountSessionRoute` → feature mounters. WS upgrade is host/origin checked too.

## Layering
- Internal selection path: `router.js` (intent) → `context.js` (`buildSystemPrompt`) → `claude.js` (Claude CLI / DeepSeek) → `db.js` → `services/kugou.js`.
- `brain.js`: `brainMode()` returns `internal` only for exact `CLAUDIO_BRAIN=internal`, else `external`; `startBrainServices` starts the scheduler only in internal.
- Route files export `mountX(app, deps)`; dependencies are injected, not imported as singletons where avoidable.

## Queue / playback
- `queue-source.js`: `markQueueSource`, `hasActiveExternalQueue` (bot queue not finished), `applyRuntimePlayback`, `trimPlayedHistory`, `reportedQueueIndex`.
- `trimPlayedHistory(runtime, keep)` slices the queue, adjusts `index`, and adds removed count to `queueOffset`. `index` is relative to the retained queue; `index + queueOffset` is the absolute position.
- `continue-pool.js`: pool in prefs; `continueFromPool` appends batches; `CLAUDIO_QUEUE_HISTORY` default 20; pool survives restarts and is not cleared by a new external queue.
- `playback-control.js`: `applyControl` (`next/prev/pause/play/toggle/volume/jump`), `applyProgress`, `queueFinished`, `restartFromStart`.
- `runtime-events.js`: `stateBroadcast`.

## Security boundary
- `auth.js`: token from Bearer / `X-Claudio-Token` / `?token=`; loopback exempt unless `CLAUDIO_REQUIRE_TOKEN`; never reads `X-Forwarded-For`.
- `session.js`: in-memory sessions; `claudio_session` HttpOnly SameSite=Strict ~30d; minted only from the raw token.
- `host-guard.js`: default hosts `localhost`, `127.0.0.1`, `[::1]`; `CLAUDIO_ALLOWED_HOSTS`; WS `Origin` checked.
- `proxy-guard.js`: domain allowlist, rejects IP literals/userinfo/non-http(s), re-checks redirects.

## Kugou
- `services/kugou.js`: `ENDPOINTS` / `LOGIN_PATH` at top differ between forks; scoring: unnamed DJ version 0, live/remix downweighted, threshold 60.
- `services/kugou-login.js`: cookie persisted in prefs, auto-refresh timer, password/QR login.
- `kugou-api-base.js`: upstream default `http://localhost:33400` (avoids Windows excluded port ranges).
- `tts.js`: Fish Audio synthesis via curl, cached mp3.
- `scripts/dev.js`: starts sibling `../KuGouMusicApi` (`npm start`) then Claudio; passes upstream `PORT`, forwards `KUGOU_PROXY` as `KUGOU_API_PROXY`.
