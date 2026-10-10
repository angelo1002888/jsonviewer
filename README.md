# jsonviewer

English | [简体中文](README_CN.md)

Live demo: https://jsonviewer-c7d.pages.dev (static hosting; content is processed in the browser only and never uploaded)

A self-hosted viewer for **JSON, YAML, TOML and XML** that replicates the three-pane layout and interactions of [bejson.com](https://www.bejson.com/jsonviewernew)'s jsonviewer, with conversion between the four formats. Implemented with the Go standard library as a single binary; the frontend is embedded via `go:embed`, so no extra static assets need to be deployed, and there are no ads or analytics. All parsing and conversion happens in the browser; pasted content is never uploaded.

## Features

- **Four formats**: JSON, YAML, TOML and XML. The format is detected automatically after pasting (the format dropdown in the left pane's title row shows e.g. "Auto · YAML"); you can also pick one manually, and the choice is remembered (per browser session). See "Formats and conversion" below.
- **Format conversion**: the middle pane has "Tree view | Convert" tabs. The Convert tab shows a read-only result with a target-format switch, copy, download, "apply to left" (undoable with Ctrl+Z), a hint bar for lossy conversions with details, and options (indent / XML root element name / XML infer types).
- **Three-pane layout**: left pane "JSON Data" (the title follows the current format: "YAML Data", ...) for input, middle pane "View" for the tree display, right pane "Properties" for details of the currently selected node.
- **Responsive / mobile**: layout follows the viewport width. Above 1100px it is three panes; from 801 to 1100px (tablets) it stays three panes with narrower side panes; at 800px and below (phones) it becomes a single pane with a "Data | View | Properties" switch bar on top. Known limitation: the tree's right-click menu is unavailable on iOS Safari.
- **Left pane tools**: copy, format, remove whitespace, remove whitespace and escape, unescape. Buttons are enabled or disabled depending on the format (see the matrix below). Format for YAML/TOML re-emits the parsed data, so comments are not kept (a toast says so; Ctrl+Z undoes it).
- **Middle pane (View)**:
  - A search box with "Previous / Next" to jump between matching nodes;
  - "Expand All / Collapse All";
  - Right-click menu: copy Key, copy Value, copy Key+Value, expand/collapse the current subtree, expand/collapse all.
- **Right pane properties table**: lists all direct children of the selected node (or its parent, if the selection is a leaf) as a "Name / Value" table; nested objects and arrays are shown as `...`.
- **No precision loss for large numbers**: numbers with 16 or more digits (outside JS `Number`'s safe integer range) are kept as their original text, so they are never rounded or truncated (in all four formats).
- **Error location**: when parsing fails, the line and column of the error are shown, and the editor cursor is automatically moved to the error position (for XML the position is approximate).
- **Large JSON performance**: the tree view uses virtual scrolling with lazy node creation, so very large files stay responsive. Benchmarks: a ~30MB JSON file parses in about 1 second, and expanding all 2.8 million lines takes about 0.5 seconds.
- **Editor**: based on CodeMirror 6. `Ctrl+Enter` parses the current content immediately, `Ctrl+F` opens text search, `Tab` indents 4 spaces.
- **Static-site deployment**: the frontend can also be deployed as a purely static site, see [docs/DEMO_SITE_CN.md](docs/DEMO_SITE_CN.md) (Chinese).
- **Optional login authentication with simple user management**: no login is required by default; when enabled, it supports multiple users, an admin role, session management, and password recovery — see "Authentication (optional)" below.

## Formats and conversion

Full design: [docs/DESIGN_CN.md](docs/DESIGN_CN.md) (Chinese), Part 2.

### Left pane tools by format

| Button | JSON | YAML | TOML | XML |
| --- | --- | --- | --- | --- |
| Copy | yes | yes | yes | yes |
| Format | yes (character scan, works on invalid JSON too) | yes (parse then re-emit; comments not kept) | yes (same as YAML) | yes (DOM re-indent; keeps comments, CDATA, processing instructions) |
| Remove whitespace | yes | disabled (indentation is significant) | disabled (newlines are significant) | yes (removes whitespace between elements) |
| Remove whitespace and escape | yes | disabled | disabled | disabled |
| Unescape | yes | disabled | disabled | disabled |

If formatting yields the same text, nothing is changed and no toast is shown.

### Auto detection

A manual choice always wins and never falls back to another format. In auto mode, the first non-blank character decides (checked in this order):

| Condition | Result |
| --- | --- |
| Starts with `<` | XML |
| Starts with `{` | JSON (a failure is reported as a JSON error, never retried as YAML) |
| Starts with `[` | TOML if the first line is a table header (`[a.b]` / `[[a]]`, bare keys, first key not a number or `true`/`false`/`null`), otherwise JSON |
| Starts with `---`, `%YAML` or `%TAG` | YAML |
| Otherwise | Scan up to 50 content lines in the first 8 KB: more TOML signals (table header, or `=` before `: `) than YAML signals (`- ` item, or `: ` before `=`) means TOML; any YAML signal means YAML |
| No signals | JSON if `JSON.parse` succeeds (bare scalars such as `123`), otherwise YAML |

If the guess is wrong, the error dialog says which format was assumed; pick the right one in the dropdown.

### XML mapping

XML is parsed with the browser's native `DOMParser` and mapped to the same tree model as the other formats:

| XML | Model |
| --- | --- |
| Document | `{ rootName: rootValue }`, the root element name is the only top-level key |
| Attribute | key `@name` (string), placed before child elements |
| Text next to attributes or children | key `#text` |
| Sibling elements with the same name | an array; a single element is **not** an array |
| Empty element (`<a/>`) | `""` |
| Values | all strings (turn on "XML infer types" in the options to get numbers / booleans; 16+ digit numbers stay raw text) |
| Namespaces | prefixes are kept verbatim in names (`soap:Envelope`); `xmlns:*` is an ordinary attribute |
| Comments, processing instructions, DOCTYPE | dropped (reported in the hint bar) |
| XML declaration | dropped; XML output always starts with `<?xml version="1.0" encoding="UTF-8"?>` |

```xml
<book id="1">
  <title>Three-Body</title>
  <tag>sci-fi</tag>
  <tag>novel</tag>
  <stock/>
</book>
```

becomes

```json
{ "book": { "@id": "1", "title": "Three-Body", "tag": ["sci-fi", "novel"], "stock": "" } }
```

When converting to XML, a top-level object with a single non-array key uses that key as the root; otherwise the data is wrapped in `<root>` (name configurable in the options). Arrays become repeated elements named after the parent key (`<item>` inside arrays and for top-level arrays).

### Conversion tab

- Source of conversion is the left pane; the source text is never changed unless you click "Apply to left". Default target: YAML when the source is JSON, otherwise JSON.
- Nothing is computed while the tree tab is shown; results are computed when you open the tab, change the target or options, or the left side is re-parsed.
- Hint bar: gray text for losses inherent to the source/target pair (e.g. "comments are not kept"); warning color for data-dependent losses, with counts and paths (e.g. `$.a.b[3]`). "Details" lists up to 50 entries. **Data-dependent losses are always reported, never silently dropped.**
- "Download" saves `converted.<ext>` locally (no server involved). "Apply to left" replaces the left text in one undoable step (Ctrl+Z); in auto mode detection stays on, in manual mode the format switches to the target.
- Options (stored in `localStorage`): indent (2 / 4; defaults JSON 4, YAML 2, XML 4; TOML has none), XML root element name (default `root`, only used when wrapping is needed), XML infer types (shown when the source is XML, default off).

### Main losses when converting

| Case | What happens |
| --- | --- |
| Comments (YAML / TOML / XML source) | not kept; YAML anchors are expanded, tags dropped; XML comments, processing instructions, DOCTYPE and CDATA marks dropped |
| Target TOML | no `null`: keys with `null` and `null` array items are dropped (later indexes shift); a top-level array is wrapped under `items`, a scalar under `value`; keys are reordered (plain keys first, then tables); non-integer 16+ digit numbers become doubles |
| Target XML | numbers / booleans / null become text; empty arrays are dropped; single-element arrays read back as a single element; invalid names are rewritten (`first name` becomes `first_name`); XML-illegal control characters become U+FFFD |
| Source XML | all values are strings (unless infer types is on); single element vs array is ambiguous; mixed content loses its order relative to child elements; non-adjacent same-name elements are merged into one array |
| Target JSON | `inf` / `nan` become `null`; TOML dates become strings |
| TOML to TOML / JSON | `1.0` becomes `1` (integer and float are not distinguished) |

### Big numbers, dates and YAML semantics

- Numbers with 16+ digits are kept as original text in JSON, YAML, TOML (integers beyond 53 bits) and XML (with infer types), and are written back verbatim. TOML floats with more than 17 significant digits still lose precision (known limitation of the library).
- TOML date/time values are shown with their own purple icon and written without quotes; fractional seconds are normalized to three digits. In YAML output they are unquoted scalars, which YAML 1.2 reads back as strings.
- YAML uses the **1.2 core** schema: `yes` / `no` / `on` are strings, dates are strings. Recursive aliases and alias bombs (more than 5 million nodes after expansion) are rejected; multi-document files show as an array ("YAML (N documents)"); duplicate keys and complex keys are errors. Integer-like keys are listed first, as in JSON.
- Non-JSON text larger than 20 MB (counted in characters) asks for confirmation before parsing, and any source that large asks before converting (with an estimated time); slow parses or conversions show a "parsing… / converting…" message first (the UI text is Chinese, as is the rest of the viewer). Parsing JSON itself is never subject to this prompt.

## Build

Requirement: **Go 1.22+** (standard library only, no third-party Go dependencies).

```bash
make build     # build the ./jsonviewer binary
make run       # build and start on 127.0.0.1:8080 with access logging, for local debugging
make test      # go vet + go test
make release   # cross-compile for linux/amd64, linux/arm64; artifacts land in dist/
```

End-to-end tests (requires Google Chrome installed locally; the script starts the compiled binary itself):

```bash
make build
npm install            # installs dev dependencies such as puppeteer-core only
npm run test:e2e       # functional + large-JSON performance checks; BIG=0 npm run test:e2e skips the performance part
npm run test:formats   # table-driven YAML / TOML / XML parse, detect, convert and loss tests (also needs the built binary and Chrome)
```

`release` consists of the `linux-amd64` and `linux-arm64` targets, which can also be run individually. The version string is injected at build time via `-ldflags -X main.version=...` (defaults to `git describe`, falling back to `dev` if unavailable).

## Running and flags

```bash
./jsonviewer -h
```

Go's `flag` package treats single and double dashes the same (`-listen` and `--listen` are equivalent); the table below uses the `-short, --long` form throughout.

| Flag | Description | Default |
| --- | --- | --- |
| `-l, --listen` | Listen address, e.g. `:8080` or `127.0.0.1:8080` | `:8080` |
| `-b, --base-path` | Sub-path to mount under when behind a reverse proxy, e.g. `/jsonviewer` | `/` |
| `-a, --access-log` | Whether to print access logs | `false` |
| `--tls-cert` (no short form) | TLS certificate file; enables HTTPS when set together with `--tls-key` | empty (disabled) |
| `--tls-key` (no short form) | TLS private key file | empty (disabled) |
| `--auth` (no short form) | Enable login authentication (first visit redirects to `/setup` to create the admin) | `false` |
| `--users-file <file>` (no short form) | Path to the user data file | `users.json` next to the config file (or in the current directory if `-c` is not used) |
| `--trusted-proxies <list>` (no short form) | Comma-separated IPs/CIDRs (e.g. `127.0.0.1, ::1, 10.0.0.0/8`); `X-Forwarded-For`/`X-Real-IP` are only trusted when the direct connection's source address is in this list | empty (no proxy header trusted; the raw TCP connection address is used) |
| `--reset-password <user>` (no short form) | Reset the given user's password (new password read from stdin) and exit; does not start the server | - |
| `-c, --config` | Path to a config file (`key = value` format) | empty (no config file) |
| `-v, --version` | Print the version and exit | - |
| `-e, --example-config` | Print a sample config file and exit | - |
| `-h, --help` | Print help and exit | - |

**Precedence**: command-line flags > config file > built-in defaults. That is, values set in the config file can be overridden by the corresponding flags; `--tls-cert` and `--tls-key` must be set together or not at all, otherwise startup fails with an error.

Generate an annotated config file template with:

```bash
./jsonviewer --example-config > jsonviewer.conf
```

The generated content looks like:

```ini
# jsonviewer 配置文件（key = value，# 开头为注释）
# 命令行参数会覆盖这里的同名配置。

# 监听地址。只想本机访问用 127.0.0.1:8080，对外用 :8080
listen = :8080

# 挂在反向代理子路径下时设置，例如 /jsonviewer ；直接根路径访问保持 /
base_path = /

# 是否输出访问日志（true / false）
access_log = false

# 同时设置证书和私钥后启用 HTTPS（浏览器剪贴板 API 需要 HTTPS 或 localhost）
# tls_cert = /etc/jsonviewer/server.crt
# tls_key  = /etc/jsonviewer/server.key

# 登录验证（true / false）。启用后首次访问进入 /setup 设置管理员
# auth = true

# 用户文件；不设 users_file 时默认为配置文件同目录下的 users.json
# users_file = /etc/jsonviewer/users.json

# 可信反向代理（逗号分隔，单个 IP 或 CIDR）。仅当直连来源在此列表内才信任
# X-Forwarded-For / X-Real-IP，用于登录限速与日志中的真实客户端 IP
# trusted_proxies = 127.0.0.1
```

(The generated file's own comments are in Chinese regardless of which README you're reading — this is the literal output of `--example-config`.)

Then start with `--config` pointing to that file:

```bash
./jsonviewer --config jsonviewer.conf
```

The service supports graceful shutdown: on receiving `SIGINT` / `SIGTERM`, it finishes in-flight requests within a 5-second timeout before exiting.

## systemd deployment

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/angelo1002888/jsonviewer/main/deploy/install.sh | sudo bash
```


What the script does: downloads the binary and verifies its SHA256, installs it to `/usr/local/bin/jsonviewer`, creates the `jsonviewer` system user, installs the systemd unit and runs `daemon-reload`, and writes `/etc/jsonviewer/jsonviewer.conf` — if that file already exists, it is left untouched and the new template is saved as `jsonviewer.conf.new` instead. It does not start the service.

Start the service:

```bash
sudo systemctl enable --now jsonviewer
```

The script is also attached to each GitHub Release, so you can download it first, review it, and then run it locally instead of piping from `curl`.

### Manual install

1. Create a dedicated unprivileged system user:

   ```bash
   sudo useradd -r -s /usr/sbin/nologin jsonviewer
   ```

2. Build and copy the binary:

   ```bash
   make build
   sudo cp jsonviewer /usr/local/bin/jsonviewer
   ```

3. Prepare the config directory and config file:

   ```bash
   sudo mkdir -p /etc/jsonviewer
   jsonviewer --example-config | sudo tee /etc/jsonviewer/jsonviewer.conf
   sudo vim /etc/jsonviewer/jsonviewer.conf   # adjust listen / base_path etc. as needed
   ```

4. Install the systemd unit file:

   ```bash
   sudo cp deploy/jsonviewer.service /etc/systemd/system/jsonviewer.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now jsonviewer
   ```

5. Check status and logs:

   ```bash
   sudo systemctl status jsonviewer
   sudo journalctl -u jsonviewer -f
   ```

6. To upgrade, just replace the binary and restart the service:

   ```bash
   sudo cp jsonviewer /usr/local/bin/jsonviewer
   sudo systemctl restart jsonviewer
   ```

   Alternatively, re-run the quick install script (it always installs the latest release) to update the binary; the existing config file is never overwritten. Then run `sudo systemctl restart jsonviewer`.

`deploy/jsonviewer.service` runs as the `jsonviewer` user by default and enables fairly strict hardening (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, etc.). To listen on a privileged port below 1024 (e.g. 80/443), uncomment the following line in the unit file; otherwise a non-root user cannot bind to that port:

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

## Authentication (optional)

No login is required by default. Set `auth = true` in the config file (or pass `--auth`) to enable it. User data is stored in the JSON file given by `users_file`; if unset, it defaults to `users.json` next to the config file (or in the current directory if `-c`/`--config` is not used).

**First-time setup**: once enabled, the first visit to any page redirects to `/setup`, where you choose an admin username (default `admin`, can be changed) and password; submitting creates the admin and logs you in automatically. After that, unauthenticated visits redirect to `/login`. Usernames must be 1-32 characters, limited to letters, digits, and `_ . -`, are case-sensitive, and cannot be changed later. Passwords must be at least 6 characters.

**Account and user management**: once logged in, a user menu appears at the right end of the middle "View" pane's title bar (shows the current username; click to open a dropdown):

- "Change password": opens a dialog inside the viewer; enter your current password, new password, and confirm the new password. On success, all your other sessions/devices are logged out immediately.
- "User management" / `/admin/users`: admin-only (menu entry hidden for non-admins; the page can also be opened directly at this URL). Add users, delete users, reset other users' passwords, and grant/revoke admin. You cannot delete yourself, and cannot delete or demote the last remaining admin.
- "Log out": a button in the dropdown (submits a POST).

The standalone `/admin/users` page also shows a status bar at the top with the current user and links/buttons for "back to viewer", "user management" (admins only), and "log out". Note: these auth pages (`/setup`, `/login`, `/admin/users`) are Chinese-only; their text is hardcoded in the Go templates.

**Sessions and security**: login state is a cookie-based session with a 7-day sliding expiry (visits more than a minute apart refresh it); sessions live in memory only, so everyone must log in again after a service restart. Deleting a user, or an admin resetting someone's password, immediately invalidates that user's session(s). Failed logins are rate-limited: 10 failures from the same IP or against the same username lock that key for 60 seconds. That IP is taken from the raw TCP connection by default; it only switches to the address in `X-Forwarded-For`/`X-Real-IP` when the connection's source is listed in `trusted_proxies` (see "Reverse proxy" below) — behind a reverse proxy without this set, rate-limiting counts every visitor as the proxy's own IP and can lock everyone out. Logins, logouts, and user/admin changes are all logged (journal). The user file is written with mode `0600` and stores only PBKDF2-SHA256 password hashes (210,000 iterations), never plaintext. (Unrelated to auth: pasted JSON content always stays in the browser and is never uploaded to the server.)

**CSRF and static asset caching**: write requests are protected by a double-submit CSRF token (an HttpOnly cookie plus a hidden form field); it does not rely on `Origin`/`Referer`/`Host`, so a reverse proxy rewriting those headers needs no special handling. Static assets use ETag-based conditional caching, so a new version is picked up automatically after an upgrade — no manual cache clearing needed.

**Recovering a lost password**:

```bash
echo 'new-password' | sudo -u jsonviewer jsonviewer -c /etc/jsonviewer/jsonviewer.conf --reset-password admin
```

`--reset-password` writes the new password to the user file and exits immediately; omit `echo 'new-password' |` to be prompted interactively instead. If the service is already running, the change takes effect automatically (the service detects that the user file was rewritten externally and reloads it) — **no restart needed**. Deleting `users.json` and restarting the service to go back to `/setup` and recreate the admin still requires a restart.

**Deployment note**: with `auth` enabled, the process needs write access to the directory holding `users_file` (it creates an empty `users.json` there on first start). `deploy/jsonviewer.service` already includes `ReadWritePaths=/etc/jsonviewer`. The quick-install script sets `/etc/jsonviewer`'s owner to `jsonviewer:jsonviewer` and `chmod`s it to `0750`, so enabling authentication after a quick install needs no extra steps. A manual install (see "Manual install" below) needs `sudo chown jsonviewer:jsonviewer /etc/jsonviewer` — otherwise the service fails to start because it cannot write the user file.

## Reverse proxy

The recommended starting point is the bundled `deploy/nginx.conf.example` (also attached to each GitHub Release). It includes an HTTP (80) to HTTPS (443) redirect, certificate paths for both Let's Encrypt and self-signed setups (the commands for each are in the file's comments), TLS settings, gzip, and both a root-path and a sub-path `location` block (use whichever matches jsonviewer's `base_path`). Copy it, fill in your domain and certificate paths per the comments, then `nginx -t && systemctl reload nginx`.

If you mount the app under a sub-path (rather than serving it at the domain root), set `base_path` to that sub-path (e.g. `/jsonviewer`) so that the frontend's asset paths match the proxy path.

It's recommended to change jsonviewer's `listen` to `127.0.0.1:8080` so it can only be reached through Nginx, not directly.

Minimal reverse-proxy `location` snippet (backend listening on `127.0.0.1:8080`, `base_path = /`):

```nginx
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_set_header   Host              $http_host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

When authentication is enabled (`auth = true`), also set `trusted_proxies = 127.0.0.1` in jsonviewer's config file (use the proxy's real address instead if it's on another host; multiple entries are comma-separated) so jsonviewer trusts the `X-Real-IP`/`X-Forwarded-For` values set above. Without it, login rate-limiting counts every visitor under the proxy's own IP (e.g. `127.0.0.1`) and one user's failed logins can lock out everybody sharing that address.

**About clipboard copy**: the browser's Clipboard API (`navigator.clipboard`) is only available over HTTPS or on `localhost`. If the app is accessed over plain HTTP through a reverse proxy (i.e. not `localhost`), the page automatically falls back to `document.execCommand('copy')`, so copying still works, but configuring HTTPS (see the `--tls-cert` / `--tls-key` flags above) is recommended for better compatibility.

## Rebuilding frontend dependencies (optional)

The third-party frontend bundles are already committed under `web/js/vendor/`, so building the Go binary day-to-day (`make build`) does not require Node. You only need to rebuild them when upgrading a dependency or modifying the entry files in `web-src/`:

```bash
npm install
npm run build:vendor   # all three bundles
```

Or rebuild a single one:

| Script | Entry | Output |
| --- | --- | --- |
| `npm run build:cm` | `web-src/codemirror-entry.js` | `web/js/vendor/codemirror.bundle.js` (CodeMirror 6 with JSON / YAML / XML / TOML highlighting) |
| `npm run build:yaml` | `web-src/yaml-entry.js` | `web/js/vendor/yaml.bundle.js` (js-yaml) |
| `npm run build:toml` | `web-src/toml-entry.js` | `web/js/vendor/toml.bundle.js` (smol-toml) |

The YAML and TOML parser bundles are loaded lazily, only when YAML / TOML is first detected or chosen as a conversion target; a JSON-only session never requests them. XML uses the browser's native `DOMParser`, so it needs no bundle. A subsequent `make build` embeds the new bundles into the binary.

## Acknowledgments and license

- The three-pane layout and the middle-pane tree view's icon style are based on [bejson.com](https://www.bejson.com/)'s jsonviewer (built on ExtJS 3).
- The editor uses [CodeMirror 6](https://codemirror.net/), licensed under MIT.
- YAML parsing and output use [js-yaml](https://github.com/nodeca/js-yaml) (MIT); TOML uses [smol-toml](https://github.com/squirrelchat/smol-toml) (BSD-3-Clause).
- Licensed under the MIT License (see LICENSE).
</content>
