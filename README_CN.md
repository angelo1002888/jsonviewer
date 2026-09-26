# jsonviewer

[English](README.md) | 简体中文

自托管的 JSON 在线视图查看器，复刻 [bejson.com](https://www.bejson.com/jsonviewernew) 的三栏布局与交互，Go 标准库实现，单一二进制，前端通过 `go:embed` 打包进二进制，无需额外部署静态资源，也没有广告和统计。

## 功能

- **三栏布局**：左栏「JSON数据」输入、中栏「视图」树形展示、右栏「属性」查看当前选中节点的详情。
- **左栏工具**：复制、格式化、删除空格、删除空格并转义、去除转义。
- **中栏（视图）**：
  - 查找框，支持「上一个 / 下一个」定位匹配节点；
  - 「全部展开 / 全部收缩」；
  - 右键菜单：复制 Key、复制 Value、复制 Key+Value、展开/收起当前子节点、展开/收起全部。
- **右栏属性表**：以「名称 / 值」表格列出选中节点（叶子节点则取其父节点）的所有直接子项，子对象与数组显示为 `...`。
- **大数字不丢精度**：超过 16 位的数字（超出 JS `Number` 安全整数范围）按字符串处理，不会被四舍五入或截断。
- **出错定位**：JSON 解析失败时，会提示出错的行号、列号，并将编辑器光标自动定位到出错位置。
- **大 JSON 性能**：树视图采用虚拟滚动、节点懒创建，可流畅处理超大文件。实测约 30MB 的 JSON 解析耗时约 1 秒，280 万行全部展开约 0.5 秒。
- **编辑器**：基于 CodeMirror 6。`Ctrl+Enter` 立即解析当前内容，`Ctrl+F` 打开文本查找，`Tab` 缩进 4 个空格。
- **可选登录验证与简单用户管理**：默认不需要登录；开启后支持多用户、管理员权限、会话管理与密码找回，详见下文「登录验证（可选）」。

## 构建

依赖：**Go 1.22+**（仅标准库，无第三方 Go 依赖）。

```bash
make build     # 编译产出 ./jsonviewer
make run       # 编译后以 127.0.0.1:8080 启动并开启访问日志，便于本地调试
make test      # go vet + go test
make release   # 交叉编译 linux/amd64、linux/arm64，产物在 dist/ 目录
```

端到端测试（需要本机安装 Google Chrome，脚本会自行启动编译好的二进制）：

```bash
make build
npm install            # 只装 puppeteer-core 等开发依赖
npm run test:e2e       # 功能 + 大 JSON 性能检查；BIG=0 npm run test:e2e 可跳过性能部分
```

`release` 由 `linux-amd64`、`linux-arm64` 两个目标组成，也可以单独执行其中之一。编译时会通过 `-ldflags -X main.version=...` 注入版本号（默认取 `git describe`，取不到则为 `dev`）。

## 运行与参数

```bash
./jsonviewer -h
```

Go 的 `flag` 包对单横线和双横线一视同仁（`-listen` 与 `--listen` 等价），下表统一用 `-短, --长` 的形式列出。

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `-l, --listen` | 监听地址，如 `:8080` 或 `127.0.0.1:8080` | `:8080` |
| `-b, --base-path` | 反向代理挂载子路径时使用，如 `/jsonviewer` | `/` |
| `-a, --access-log` | 是否打印访问日志 | `false` |
| `--tls-cert`（无短名） | TLS 证书文件；与 `--tls-key` 同时设置后启用 HTTPS | 空（不启用） |
| `--tls-key`（无短名） | TLS 私钥文件 | 空（不启用） |
| `--auth`（无短名） | 启用登录验证（首次访问进入 `/setup` 设置管理员） | `false` |
| `--users-file <file>`（无短名） | 用户文件路径 | 配置文件同目录下的 `users.json`（未用 `-c` 时为当前目录） |
| `--reset-password <user>`（无短名） | 重置指定用户的密码后退出（新密码从标准输入读取），不启动服务 | - |
| `-c, --config` | 配置文件路径（`key = value` 格式） | 空（不使用配置文件） |
| `-v, --version` | 显示版本号并退出 | - |
| `-e, --example-config` | 输出一份示例配置文件内容并退出 | - |
| `-h, --help` | 显示帮助并退出 | - |

**优先级**：命令行参数 > 配置文件 > 内置默认值。也就是说，配置文件里写的值可以被同名命令行参数覆盖；`--tls-cert` 和 `--tls-key` 必须同时设置或同时不设置，否则启动会报错退出。

可以用以下命令生成一份带注释的配置文件模板：

```bash
./jsonviewer --example-config > jsonviewer.conf
```

生成的内容形如：

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
```

然后用 `--config` 指定该文件启动：

```bash
./jsonviewer --config jsonviewer.conf
```

服务支持优雅退出：收到 `SIGINT` / `SIGTERM` 后会在 5 秒超时内完成正在进行的请求再退出。

## systemd 部署

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/angelo1002888/jsonviewer/main/deploy/install.sh | sudo bash
```

带参数示例（指定监听地址与版本）：

```bash
curl -fsSL https://raw.githubusercontent.com/angelo1002888/jsonviewer/main/deploy/install.sh | sudo bash -s -- -l 127.0.0.1:8080 -v v0.1.1
```

| 参数 | 说明 |
| --- | --- |
| `-v, --version <tag>` | 安装指定版本（如 `v0.1.1`），默认最新 Release |
| `-l, --listen <addr>` | 写入新配置文件的监听地址，默认 `:8080` |

脚本会做的事：下载二进制并校验 SHA256，安装到 `/usr/local/bin/jsonviewer`，创建 `jsonviewer` 系统用户，安装 systemd 单元并执行 `daemon-reload`，写入 `/etc/jsonviewer/jsonviewer.conf`——若该文件已存在则不覆盖，新模板另存为 `jsonviewer.conf.new`。脚本不会自动启动服务。

启动：

```bash
sudo systemctl enable --now jsonviewer
```

该脚本也作为每个 GitHub Release 的附件提供，可以先下载到本地审阅内容，再执行，不必直接 `curl | sudo bash`。

### 手动安装

1. 创建专用的非特权系统用户：

   ```bash
   sudo useradd -r -s /usr/sbin/nologin jsonviewer
   ```

2. 编译并复制二进制：

   ```bash
   make build
   sudo cp jsonviewer /usr/local/bin/jsonviewer
   ```

3. 准备配置目录与配置文件：

   ```bash
   sudo mkdir -p /etc/jsonviewer
   jsonviewer --example-config | sudo tee /etc/jsonviewer/jsonviewer.conf
   sudo vim /etc/jsonviewer/jsonviewer.conf   # 按需修改 listen / base_path 等
   ```

4. 安装 systemd 单元文件：

   ```bash
   sudo cp deploy/jsonviewer.service /etc/systemd/system/jsonviewer.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now jsonviewer
   ```

5. 查看运行状态与日志：

   ```bash
   sudo systemctl status jsonviewer
   sudo journalctl -u jsonviewer -f
   ```

6. 更新版本时，只需替换二进制后重启服务：

   ```bash
   sudo cp jsonviewer /usr/local/bin/jsonviewer
   sudo systemctl restart jsonviewer
   ```

   也可以重新执行一键安装脚本（可加 `-v` 指定版本）来更新二进制，配置文件不会被覆盖，然后执行 `sudo systemctl restart jsonviewer`。

`deploy/jsonviewer.service` 默认以 `jsonviewer` 用户运行，并开启了较严格的安全加固（`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp` 等）。如果要监听 1024 以下的特权端口（如 80/443），需要在 unit 文件中取消下面这一行的注释，否则非 root 用户无法绑定该端口：

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

## 登录验证（可选）

默认不需要登录。设置 `auth = true`（或加 `--auth` 参数）后启用登录验证；用户数据保存在 `users_file` 指定的 JSON 文件里，不设置时默认为配置文件同目录下的 `users.json`（未使用 `-c`/`--config` 时为当前目录下的 `users.json`）。

**首次设置**：启用后首次访问任意页面会跳转到 `/setup`，填写管理员用户名（默认 `admin`，可改）和密码即可创建管理员并自动登录。之后未登录访问会跳转到 `/login`。用户名 1–32 个字符，仅限字母、数字和 `_ . -`，区分大小写，创建后不可修改；密码最少 6 个字符。

**账户与用户管理**：登录后，中栏「视图」面板标题栏右侧会出现用户菜单（显示当前用户名，点开下拉菜单），也可以直接访问对应地址：

- 「修改密码」/ `/account`：修改自己的密码（需先输入当前密码）；修改成功后会使本账户在其它设备上的登录立即失效。
- 「用户管理」/ `/admin/users`：仅管理员可见/访问，可新增用户、删除用户、重置他人密码、设置或取消管理员；不能删除自己，也不能删除或降级最后一个管理员。
- 「退出登录」：下拉菜单里的按钮（POST 请求）。

`/account`、`/admin/users` 这两个独立页面顶部也有一条状态栏，显示当前用户，并提供「返回查看器」「账户设置」「用户管理」（仅管理员可见）「退出登录」几个链接/按钮；这些页面（含 `/setup`、`/login`）文案固定为中文。

**会话与安全**：登录状态通过 Cookie 保存，7 天滑动过期（距上次续期超过 1 分钟的访问会自动续期），会话保存在内存中，服务重启后所有人都需要重新登录；删除某用户，或管理员重置了某用户的密码后，该用户的会话会立即失效。登录失败会限速：同一 IP 或同一用户名连续失败 10 次后锁定 60 秒。登录、登出、新增/删除用户、重置密码、修改管理员权限等操作都会记录到日志（journal）。用户文件权限固定为 `0600`，只保存密码的 PBKDF2-SHA256（21 万次迭代）哈希，不保存明文密码。（顺带一提：查看器里粘贴的 JSON 内容始终只保存在浏览器本地、不会上传服务器，这与是否启用登录验证无关。）

**忘记密码时恢复**：

```bash
echo '新密码' | sudo -u jsonviewer jsonviewer -c /etc/jsonviewer/jsonviewer.conf --reset-password admin
```

`--reset-password` 把新密码写入用户文件后立即退出；省略 `echo '新密码' |` 会在终端交互提示输入。服务运行中执行该命令会自动生效（服务检测到用户文件被外部改写后自动重新加载），**不需要重启**。删除 `users.json` 后重启服务、回到 `/setup` 重新创建管理员的方式则仍需要重启服务。

**部署注意事项**：启用 `auth` 后，进程需要能写入 `users_file` 所在目录（首次启动会在该目录创建空的 `users.json`）。`deploy/jsonviewer.service` 已包含 `ReadWritePaths=/etc/jsonviewer`；一键安装脚本会把 `/etc/jsonviewer` 属主设为 `jsonviewer:jsonviewer` 并 `chmod 0750`，因此用一键安装启用登录验证无需额外操作。手动安装（见下文"手动安装"）需要自行执行 `sudo chown jsonviewer:jsonviewer /etc/jsonviewer`，否则服务会因无法写入用户文件而启动失败。

## 反向代理

若通过 Nginx 等反向代理挂在子路径下（而不是直接用域名根路径访问），需要将 `base_path` 设置为对应的子路径（例如 `/jsonviewer`），保证前端资源引用的路径与代理路径一致。

启用登录验证时，反向代理必须原样转发 `Host` 请求头（用于同源校验，POST 请求会校验 `Origin`/`Host`）；若通过 HTTPS 反代访问，还需设置 `X-Forwarded-Proto https`，登录会话的 Cookie 才会带上 `Secure` 标记。

Nginx 最小配置片段示例（假设子路径为 `/jsonviewer`，后端监听 `127.0.0.1:8080`，`base_path = /jsonviewer`）：

```nginx
location /jsonviewer/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**关于剪贴板复制**：浏览器的 Clipboard API（`navigator.clipboard`）只在 HTTPS 或 `localhost` 环境下可用。如果通过 HTTP 反向代理对外访问（非 `localhost`），页面会自动降级使用 `document.execCommand('copy')` 方案，复制功能依然可用，但建议尽量配置 HTTPS（见上文 `--tls-cert` / `--tls-key` 参数）以获得更好的兼容性。

## 重建前端依赖（可选）

前端使用的 CodeMirror 6 打包产物已经提交在 `web/js/vendor/codemirror.bundle.js`，日常构建 Go 二进制（`make build`）不需要 Node 环境。只有在需要升级 CodeMirror 版本或修改 `web-src/codemirror-entry.js` 时才需要重新打包：

```bash
npm install
npm run build:cm
```

产物会重新生成到 `web/js/vendor/codemirror.bundle.js`，之后正常 `make build` 即可把新产物打进二进制。

## 致谢与许可

- 三栏布局与中间栏树视图的图标风格参考自 [bejson.com](https://www.bejson.com/) 的 jsonviewer（基于 ExtJS 3 实现）。
- 编辑器使用 [CodeMirror 6](https://codemirror.net/)，遵循 MIT 协议。
- 本项目仅供个人自托管使用。
</content>
</invoke>
