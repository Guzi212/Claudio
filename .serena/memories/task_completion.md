# Definition of done

1. `npm test` — all vitest suites green (CI runs the same command).
2. PWA shell asset changed? Bump `pwa/sw.js` `CACHE` and update the version assertion in tests.
3. UI changed? Run `node scripts/verify-radio-ui.mjs <outdir>` with local Chrome; check wide and tall layouts.
4. API/route changed? Add or update the matching `tests/*.test.js`.
5. No linter, formatter, or typecheck is configured — don't invent one.
6. Stage only task files by explicit path (no `git add .`); remember the post-commit hook writes `docs/devlog.md`.
7. Push the branch, open a PR to `main`, wait for CI green, squash-merge, then remove the worktree.
