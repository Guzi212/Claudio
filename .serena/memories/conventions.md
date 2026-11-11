# Conventions

- Comments and UI copy are Chinese; identifiers and commit prefixes are English.
- ESM with explicit `.js` extensions; modules commonly `export default` a function/object plus named helpers.
- Prefer extracting pure helpers for testability (`buildDevConfig`, `resolveListenHost`, `trimPlayedHistory`, guard predicates) and inject dependencies (`mountX(app, deps)`).
- API errors return `{ ok: false, error }`; never echo Host, tokens, or internal URLs in responses or logs.
- Security-sensitive code lives in dedicated modules (`auth`, `host-guard`, `proxy-guard`, `session`); don't duplicate checks in routes.
- PWA: no inline secrets; token → session cookie exchange; `?token=` never cached.
- Tests: one `tests/<area>.test.js` per behaviour; prefer testing exported helpers over HTTP where possible.
- Commits: `feat:` / `fix:` / `chore:` + short Chinese summary. `.githooks/post-commit` appends a line to `docs/devlog.md`.
- UI copy: no helper text under titles/labels unless it prevents a real mistake.
