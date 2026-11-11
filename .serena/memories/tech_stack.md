# Tech stack

- Node >= 22.12 (CI uses 22), ESM (`"type": "module"`), plain JavaScript — no TypeScript, no bundler, no build step.
- Runtime deps: `express@4`, `ws@8`, `axios`, `dotenv`, `node-cron`. Dev: `vitest@5`, `concurrently`.
- SQLite via Node built-in `node:sqlite` (`DatabaseSync`); no native compilation.
- PWA is hand-written: service worker, manifest, ES modules.
- Tests: vitest with `pool: 'forks'` and `fileParallelism: false` (shared `state.db` would otherwise hit SQLite locks); `server.deps.external` includes `node:` and `sqlite`.
- Upstream dependency: sibling `KuGouMusicApi` fork (`../KuGouMusicApi`), default `http://localhost:33400`.
- Package manager: npm only (`package-lock.json`; no pnpm/yarn lock).
- CI: `.github/workflows/ci.yml` runs on PRs to `main` — `npm ci` + `npm test` on Ubuntu with Node 22.
