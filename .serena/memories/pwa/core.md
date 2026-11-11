# pwa/

Vanilla ES modules, no framework/bundler/build step. `pwa/index.html` loads `app.js` and modules directly.

## Structure
- `app.js`: bootstrap (`adoptUrlToken` → `startApp`), view routing, WebSocket wiring.
- `views/`: `player`, `playlists`, `profile`, `settings`, `ui`.
- `components/`: `lyrics`, `env-strip`, `studio-visual`.
- Playback runtime: `external-playback.js`, `boot-playback.js`, `runtime-sync.js`, `player-mode.js`, `media-session.js`, `volume-memory.js`, `client-id.js`, `session-url.js`.

## Invariants
- `sw.js` caches the shell only; `/api/*` and audio never cached; requests with `?token=` bypass the cache so the token never lands in Cache Storage.
- Shell list and `CACHE = 'claudio-shell-vN'` must be bumped together with the test assertion when shell assets change.
- `navigator.mediaSession` is registered in the playback runtime, not inside a view, so replacing the player view keeps media keys working.
- Progress reports (~2s over WS `/stream`) include `index` and the `queueOffset` received with the queue; the server ignores reports for trimmed tracks.
- UI is 宣纸水墨 with time-of-day palettes; wide and tall backgrounds; avatar is the ink-blot Grokbot.
- No secrets in static files: `?token=` is exchanged for an HttpOnly session cookie, then stripped from the URL via `history.replaceState`.
