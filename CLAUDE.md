# jsonviewer

Self-hosted online JSON viewer that replicates the three-pane layout and features of bejson.com/jsonviewernew (no ads, no analytics).

## Layout
- `main.go`: Go standard-library HTTP server; `//go:embed web` bakes the frontend into a single binary. Flags accept short and long forms (`-l`/`--listen`, ...); see `-h` and `deploy/jsonviewer.conf` for the config-file format. Precedence: flags > config file > defaults.
- `web/`: frontend. `index.html`, `css/style.css`, `js/app.js` (vanilla JS, no framework), `js/vendor/codemirror.bundle.js` (pre-bundled CodeMirror 6), `assets/ico/` (ExtJS-style tree icons).
- `web-src/codemirror-entry.js` + `package.json`: only for rebuilding the CodeMirror bundle (`npm i && npm run build:cm`). Node is not needed for the normal Go build.
- `deploy/`: systemd unit, example config, and `install.sh` (one-shot installer that pulls a GitHub Release).
- `tests/e2e.js`: headless-Chrome end-to-end + large-JSON performance test (`npm run test:e2e`, `BIG=0` skips the perf part).
- `.github/workflows/`: `ci.yml` (gofmt, vet, build, smoke, e2e) and `release.yml` (tag `v*` -> multi-platform binaries + service/conf/install.sh + SHA256SUMS).
- `Makefile`: `make build` / `make release`. Docs: `README.md` (English) and `README_CN.md` (Chinese); keep both in sync.

## Conventions
- The tree view (middle pane) keeps the ExtJS structure: 18px rows, elbow lines and plus/minus icons, selection color #d9e8fb; text is 12px monospace, vertically centered with the icons (user preference, 2026-09-26). Everything else is a clean light theme and may be restyled freely.
- Performance is a hard requirement: the tree must stay virtualized with lazily created nodes; the editor is CodeMirror (a textarea is unusable on large text); parsing uses the native JSON.parse fast path and only falls back to big-number protection when a 16+ digit number is present.
- Go: standard library only. Frontend: no frameworks, no CDN.
- Verification: `make build`, run the binary, then run the headless-Chrome tests (puppeteer-core + local google-chrome).
- **Never commit or push unless the user explicitly asks for it in the current request.** Leave changes in the working tree and report them; do not create tags or releases on your own either.

## Model routing (subagents)
- Planning, design, trade-offs, reviews -> `architect` (Fable, read-only advisor). Get a plan from it before any non-trivial change.
- Implementation, bug fixes, refactoring -> `coder` (Opus). The main session model is also Opus (`.claude/settings.json`).
- README, deployment docs, config docs -> `doc-writer` (Sonnet).
- Running tests/builds, and git commit/push when the user asks -> `ops` (Haiku).
- For hard planning questions in the main session use the advisor (`advisorModel = fable`).
