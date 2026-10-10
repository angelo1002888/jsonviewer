# jsonviewer

Self-hosted online viewer for JSON, YAML, TOML and XML (with conversion between them) that replicates the three-pane layout and features of bejson.com/jsonviewernew (no ads, no analytics).

## Layout
- `main.go`: Go standard-library HTTP server; `//go:embed web` bakes the frontend into a single binary. Flags accept short and long forms (`-l`/`--listen`, ...); see `-h` and `deploy/jsonviewer.conf` for the config-file format. Precedence: flags > config file > defaults.
- `web/`: frontend. `index.html`, `css/style.css`, `js/app.js` (vanilla JS, no framework: UI, tree, check flow, conversion panel), `assets/ico/` (ExtJS-style tree icons, plus `purple.gif` for date nodes).
- `web/js/formats.js`: format adapters (JSON/YAML/TOML/XML parse, stringify, detection, XML mapping, lazy vendor loader); exposes `window.JV`.
- `web/js/vendor/`: pre-bundled third-party code. `codemirror.bundle.js` (CodeMirror 6 with json/yaml/xml/toml highlighting) is loaded eagerly; `yaml.bundle.js` (js-yaml) and `toml.bundle.js` (smol-toml) are lazy-loaded.
- `web-src/` (`codemirror-entry.js`, `yaml-entry.js`, `toml-entry.js`) + `package.json`: only for rebuilding the vendor bundles (`npm i && npm run build:vendor`, or `build:cm` / `build:yaml` / `build:toml`). Node is not needed for the normal Go build.
- `deploy/`: systemd unit, example config, and `install.sh` (one-shot installer that pulls a GitHub Release). `deploy/pages/` holds platform-only files for the static demo (`_headers`, `404.html`, `robots.txt`).
- `tests/e2e.js`: headless-Chrome end-to-end + large-JSON performance test (`npm run test:e2e`, `BIG=0` skips the perf part).
- `tests/formats.js`: table-driven format tests (parse, detection, conversion, losses) in headless Chrome against the built binary (`npm run test:formats`).
- `.github/workflows/`: `ci.yml` (gofmt, vet, build, smoke, e2e, formats) and `release.yml` (tag `v*` -> multi-platform binaries + service/conf/install.sh + SHA256SUMS), `pages.yml` (tag `v*` -> Cloudflare Pages demo, assembles `web/` + `deploy/pages/`).
- `Makefile`: `make build` / `make release`. Docs: `README.md` (English) and `README_CN.md` (Chinese); keep both in sync.
- `docs/DESIGN_CN.md`: design document (Chinese). Part 1 is the as-built design and must be kept consistent with the code; Part 2 is the multi-format (JSON/YAML/TOML/XML) viewing and conversion design, implemented (deviations are recorded in section 22). All diagrams are mermaid and must render on GitHub. `docs/DEMO_SITE_CN.md`: public demo hosting guide (Chinese).

## Conventions
- The tree view (middle pane) keeps the ExtJS structure: 18px rows, elbow lines and plus/minus icons, selection color #d9e8fb; text is 12px monospace, vertically centered with the icons (user preference, 2026-09-26). Everything else is a clean light theme and may be restyled freely.
- Responsive layout is driven by viewport width in three tiers: >1100px three panes, 801-1100px three narrower panes, <=800px single pane with the `#app[data-pane]` switch bar. Narrow-screen rules live together in the media queries in `style.css`; when a hidden pane is shown again it must be re-measured (`tree.invalidate()` / `view.requestMeasure()`, see `showPane` in `app.js`).
- Performance is a hard requirement: the tree must stay virtualized with lazily created nodes; the editor is CodeMirror (a textarea is unusable on large text); parsing uses the native JSON.parse fast path and only falls back to big-number protection when a 16+ digit number is present.
- JSON keeps the native `JSON.parse` fast path and must not load the yaml/toml bundles. Conversions must report data-dependent losses in the hint bar, never silently drop data.
- Go: standard library only. Frontend: no frameworks, no CDN.
- `deploy/pages/` files must never be placed under `web/` (they would be embedded into the binary); the demo must stay static-only, no analytics.
- Verification: `make build`, run the binary, then run the headless-Chrome tests (puppeteer-core + local google-chrome).
- **Never commit or push unless the user explicitly asks for it in the current request.** Leave changes in the working tree and report them; do not create tags or releases on your own either.

## Model routing (subagents)
- Planning, design, trade-offs, reviews -> `architect` (Fable, read-only advisor). Get a plan from it before any non-trivial change.
- Implementation, bug fixes, refactoring -> `coder` (Opus). The main session model is also Opus (`.claude/settings.json`).
- README, deployment docs, config docs -> `doc-writer` (Sonnet).
- Running tests/builds, and git commit/push when the user asks -> `ops` (Haiku).
- For hard planning questions in the main session use the advisor (`advisorModel = fable`).
