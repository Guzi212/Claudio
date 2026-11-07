# Claudio

Personal AI radio. Default `CLAUDIO_BRAIN=external`: an external Grok Bot picks tracks; Claudio only does Kugou search/direct URLs and browser PWA playback. `internal` restores Claude-side selection (boot, chat, scheduler).

## Source map
- `server/` — Node backend (Express + ws), entry `server/app.js`; route mounters in `server/api/*`, Kugou integration in `server/services/`.
- `pwa/` — hand-written vanilla-JS PWA (no framework, no bundler); views/components under `pwa/views`, `pwa/components`.
- `tests/` — vitest suites, one file per behaviour area.
- `prompts/dj-persona.md` — internal-mode persona + JSON schema.
- `user/` — taste corpus consumed by the bot/internal prompt.
- `scripts/` — dev launcher, Kugou import, UI verification, Windows hotkey PowerShell.

## Invariants
- External mode must never call Claude; `server/claude.js` is only reached when `brainMode() === 'internal'`.
- `/api/proxy` forwards only `kugou.com` / `kgimg.com` (+ subdomains); every redirect hop is re-validated.
- `/api/*`, `/tts/*` and WS `/stream` are token/host gated; static PWA shell is public and must contain no secrets.
- PWA shell changes require bumping `pwa/sw.js` `CACHE` (`claudio-shell-vN`) and the version assertion in tests.
- SQLite is Node built-in `node:sqlite`; no native modules.
- One task per git worktree; never edit `main` directly (see project `CLAUDE.md`).

## Read next
- Backend structure and invariants: `mem:server/core`
- Frontend structure and playback flow: `mem:pwa/core`
- Stack, commands, conventions, done-checks: `mem:tech_stack`, `mem:suggested_commands`, `mem:conventions`, `mem:task_completion`
