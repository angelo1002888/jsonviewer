# jsonviewer

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
```

然后用 `--config` 指定该文件启动：

```bash
./jsonviewer --config jsonviewer.conf
```

服务支持优雅退出：收到 `SIGINT` / `SIGTERM` 后会在 5 秒超时内完成正在进行的请求再退出。

## systemd 部署

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

`deploy/jsonviewer.service` 默认以 `jsonviewer` 用户运行，并开启了较严格的安全加固（`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp` 等）。如果要监听 1024 以下的特权端口（如 80/443），需要在 unit 文件中取消下面这一行的注释，否则非 root 用户无法绑定该端口：

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

## 反向代理

若通过 Nginx 等反向代理挂在子路径下（而不是直接用域名根路径访问），需要将 `base_path` 设置为对应的子路径（例如 `/jsonviewer`），保证前端资源引用的路径与代理路径一致。

Nginx 最小配置片段示例（假设子路径为 `/jsonviewer`，后端监听 `127.0.0.1:8080`，`base_path = /jsonviewer`）：

```nginx
location /jsonviewer/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
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
