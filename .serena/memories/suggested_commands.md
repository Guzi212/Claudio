# Commands

## Run
- `npm ci` — CI-parity install (use `npm install` only when changing deps).
- `npm run dev` — starts sibling `../KuGouMusicApi` then Claudio; needs that repo installed.
- `npm run dev:app` — Claudio only (no upstream).
- `npm start` — alias of `npm run dev`.

## Test
- `npm test` — `vitest run`.
- `npm run test:watch`.

## Data / UI
- `npm run music:import:kugou` — parse `user/music/kugou_input.txt` into raw + taste summary.
- `node scripts/import-kugou-data.js --apply-taste` — write the distilled section into `user/taste.md`.
- `node scripts/verify-radio-ui.mjs <outdir>` — visual check, needs local Chrome.

## Serena
- `serena project index` — refresh symbol cache after large changes.
- `serena memories check` — find stale `mem:` references.

## Windows notes
- Spawning `.cmd` needs `shell: true` (see `scripts/dev.js`); use `npm.cmd` when spawning npm.
- Hotkey tooling is PowerShell: `scripts/claudio-hotkey-listener.ps1 -Action Start|Status|Stop|Check`.
- `npm run prepare` sets `git config core.hooksPath .githooks`.

## Git worktree flow (project rule)
`git fetch origin main` → `git worktree add ../claudio-<name> -b feat/<name>` → `npm ci`; finish with `npm test` → push → `gh pr create --base main` → wait for CI → `gh pr merge --squash` → `git worktree remove`.
