# jsonviewer

[English](README.md) | 简体中文

在线演示：https://jsonviewer-c7d.pages.dev（纯静态托管，内容只在浏览器处理，不上传）

自托管的 **JSON / YAML / TOML / XML** 在线视图查看器，复刻 [bejson.com](https://www.bejson.com/jsonviewernew) 的三栏布局与交互，并支持四种格式互转。Go 标准库实现，单一二进制，前端通过 `go:embed` 打包进二进制，无需额外部署静态资源，也没有广告和统计。所有解析与转换都在浏览器内完成，粘贴的内容不会上传。

## 功能

- **四种格式**：JSON、YAML、TOML、XML。粘贴后自动识别（左栏标题行的格式下拉显示「自动 · YAML」这样的徽标），也可手动指定，手动选择会被记住（同一浏览器会话内）。详见下文「多格式与转换」。
- **格式互转**：中栏有「树视图 | 转换」标签页。转换页给出只读结果，可切换目标格式、复制、下载、「应用到左侧」（Ctrl+Z 可撤销）；有损转换时显示提示条并可查看详情；选项含缩进、XML 根元素名、XML 推断类型。
- **三栏布局**：左栏「JSON数据」输入（标题随当前格式显示为「YAML数据」等）、中栏「视图」树形展示、右栏「属性」查看当前选中节点的详情。
- **左栏工具**：复制、格式化、删除空格、删除空格并转义、去除转义；按钮随格式启用或禁用（见下文矩阵）。YAML / TOML 的「格式化」是解析后重新输出，不保留注释（会弹 toast 提示，Ctrl+Z 可撤销）。
- **中栏（视图）**：
  - 查找框，支持「上一个 / 下一个」定位匹配节点；
  - 「全部展开 / 全部收缩」；
  - 右键菜单：复制 Key、复制 Value、复制 Key+Value、展开/收起当前子节点、展开/收起全部。
- **右栏属性表**：以「名称 / 值」表格列出选中节点（叶子节点则取其父节点）的所有直接子项，子对象与数组显示为 `...`。
- **大数字不丢精度**：16 位及以上的数字（超出 JS `Number` 安全整数范围）保留原文，不会被四舍五入或截断（四种格式都适用）。
- **出错定位**：解析失败时，会提示出错的行号、列号，并将编辑器光标自动定位到出错位置（XML 的位置是近似值）。
- **大 JSON 性能**：树视图采用虚拟滚动、节点懒创建，可流畅处理超大文件。实测约 30MB 的 JSON 解析耗时约 1 秒，280 万行全部展开约 0.5 秒。
- **编辑器**：基于 CodeMirror 6。`Ctrl+Enter` 立即解析当前内容，`Ctrl+F` 打开文本查找，`Tab` 缩进 4 个空格。
- **可作静态站部署**：前端也可直接作为纯静态站部署，见 [docs/DEMO_SITE_CN.md](docs/DEMO_SITE_CN.md)。
- **可选登录验证与简单用户管理**：默认不需要登录；开启后支持多用户、管理员权限、会话管理与密码找回，详见下文「登录验证（可选）」。

## 多格式与转换

完整设计见 [docs/DESIGN_CN.md](docs/DESIGN_CN.md) 第二部分。

### 左栏工具按钮随格式启用或禁用

| 按钮 | JSON | YAML | TOML | XML |
| --- | --- | --- | --- | --- |
| 复制 | 可用 | 可用 | 可用 | 可用 |
| 格式化 | 可用（字符扫描，对非法 JSON 也能工作） | 可用（解析后重排，不保留注释） | 可用（同 YAML） | 可用（DOM 重排缩进，保留注释、CDATA、处理指令） |
| 删除空格 | 可用 | 禁用（缩进有语义） | 禁用（换行有语义） | 可用（去除元素间的空白） |
| 删除空格并转义 | 可用 | 禁用 | 禁用 | 禁用 |
| 去除转义 | 可用 | 禁用 | 禁用 | 禁用 |

格式化结果与原文相同时，不更新文本也不提示。

### 自动识别规则

手动指定的格式永远优先，且不会回退到别的格式。自动模式按以下顺序判断（看第一个非空白字符）：

| 条件 | 结果 |
| --- | --- |
| 以 `<` 开头 | XML |
| 以 `{` 开头 | JSON（失败就报 JSON 错误，不会改按 YAML 重试） |
| 以 `[` 开头 | 首行是 TOML 表头（`[a.b]` / `[[a]]`，裸键，首个键不是纯数字或 `true`/`false`/`null`）判为 TOML，否则 JSON |
| 以 `---`、`%YAML`、`%TAG` 开头 | YAML |
| 其余 | 扫描前 8 KB 内最多 50 个有效行：TOML 信号（表头，或 `=` 出现在 `: ` 之前）多于 YAML 信号（`- ` 开头，或 `: ` 出现在 `=` 之前）判 TOML；有 YAML 信号判 YAML |
| 两边信号都为 0 | `JSON.parse` 成功判 JSON（如 `123` 这类标量），否则 YAML |

识别错了时，错误对话框会说明当前按哪种格式解析，在格式下拉里手动选对即可。

### XML 映射约定

XML 用浏览器原生 `DOMParser` 解析，映射为与其他格式相同的树模型：

| XML | 模型 |
| --- | --- |
| 文档 | `{ 根元素名: 根元素值 }`，根元素名是唯一的顶层键 |
| 属性 | 键 `@名`（字符串），排在子元素之前 |
| 与属性或子元素并存的文本 | 键 `#text` |
| 同名兄弟元素 | 数组；只出现一次时**不是**数组 |
| 空元素 `<a/>` | `""` |
| 值 | 默认全是字符串（在选项里开启「XML 推断类型」可得到数字与布尔；16 位以上数字保留原文） |
| 命名空间 | 前缀原样保留在键名中（`soap:Envelope`），`xmlns:*` 当普通属性 |
| 注释、处理指令、DOCTYPE | 丢弃（提示条会说明） |
| XML 声明 | 丢弃；输出 XML 时固定以 `<?xml version="1.0" encoding="UTF-8"?>` 开头 |

```xml
<book id="1">
  <title>三体</title>
  <tag>科幻</tag>
  <tag>长篇</tag>
  <stock/>
</book>
```

映射为：

```json
{ "book": { "@id": "1", "title": "三体", "tag": ["科幻", "长篇"], "stock": "" } }
```

转为 XML 时：顶层是只有一个键且该键值不是数组的对象，就用该键作根元素；否则包一层 `<root>`（名字可在选项里改）。数组写成以父键名重复的元素（数组里嵌数组和顶层数组使用 `<item>`）。

### 转换标签页

- 转换的源是左栏，除非点「应用到左侧」，否则不会改动源文本。默认目标：源是 JSON 时为 YAML，否则为 JSON。
- 停在树视图标签时不做任何转换；切到转换标签、切换目标或选项、左侧重新解析成功时才计算。
- 提示条：灰色文字是由源和目标格式决定的固有损失（如「注释不保留」）；警告色是与数据有关的实际损失，附数量和路径（如 `$.a.b[3]`），「详情」最多列 50 条。**与数据有关的损失一律会提示，不会静默丢数据。**
- 「下载」在本地保存 `converted.<扩展名>`，不经过服务端。「应用到左侧」用一次可撤销的操作（Ctrl+Z）替换左侧文本；自动模式保持自动识别，手动模式则切到目标格式。
- 选项（保存在 `localStorage`）：缩进（2 / 4，默认 JSON 4、YAML 2、XML 4，TOML 无缩进）、XML 根元素名（默认 `root`，仅在需要包装时使用）、XML 推断类型（仅源为 XML 时显示，默认关）。

### 转换时的主要损失

| 情形 | 结果 |
| --- | --- |
| 注释（YAML / TOML / XML 源） | 不保留；YAML 锚点按值展开、标签丢弃；XML 的注释、处理指令、DOCTYPE、CDATA 标记丢弃 |
| 目标 TOML | 无 `null`：值为 `null` 的键与数组里的 `null` 元素被丢弃（后续下标前移）；顶层数组包到 `items` 键下、顶层标量包到 `value` 键下；键序调整（普通键在前，表在后）；16 位以上的非整数数字转为双精度浮点 |
| 目标 XML | 数字、布尔、null 变为文本；空数组丢弃；单元素数组读回时是单个元素；非法键名被改写（`first name` 变 `first_name`）；XML 不允许的控制字符替换为 U+FFFD |
| 源 XML | 值全是字符串（除非开了推断类型）；单个元素与数组无法区分；混合内容与子元素的相对顺序丢失；不连续的同名元素被归并进同一数组 |
| 目标 JSON | `inf` / `nan` 变 `null`；TOML 日期变字符串 |
| TOML 到 TOML / JSON | `1.0` 变 `1`（整数与浮点不区分） |

### 大数、日期与 YAML 语义

- 16 位以上的数字在 JSON、YAML、TOML（超过 53 位的整数）和 XML（开启推断类型时）中都保留原文，写回时原样输出。TOML 超过 17 位有效数字的浮点仍会丢精度（所用库没有对应选项，属已知限制）。
- TOML 日期时间用单独的紫色图标显示，写回时不带引号；小数秒会补齐为三位。输出为 YAML 时是不带引号的标量，按 YAML 1.2 读回是字符串。
- YAML 按 **1.2 core** 语义：`yes` / `no` / `on` 是字符串，日期是字符串。递归别名与别名炸弹（展开后超过 500 万个节点）会被拒绝；多文档显示为数组（根标签「YAML（N 个文档）」）；重复键与复合键报错；整数形式的键排在最前，与 JSON 一致。
- 非 JSON 文本超过 20 MB（按字符数计）时，解析或转换前会弹确认框（给出预计耗时）；耗时较长时先显示「正在解析… / 正在转换…」。JSON 的解析本身不受此限制（对超大 JSON 做转换时同样会先确认）。

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
npm run test:formats   # YAML / TOML / XML 的解析、识别、转换与损失表驱动测试（同样需要已编译的二进制和 Chrome）
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
| `--trusted-proxies <list>`（无短名） | 逗号分隔的 IP 或 CIDR 列表（如 `127.0.0.1, ::1, 10.0.0.0/8`）；只有直连来源在列表内时才信任其 `X-Forwarded-For`/`X-Real-IP` | 空（不信任任何代理头，直接用 TCP 连接地址） |
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

# 可信反向代理（逗号分隔，单个 IP 或 CIDR）。仅当直连来源在此列表内才信任
# X-Forwarded-For / X-Real-IP，用于登录限速与日志中的真实客户端 IP
# trusted_proxies = 127.0.0.1
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

   也可以重新执行一键安装脚本（始终安装最新 Release）来更新二进制，配置文件不会被覆盖，然后执行 `sudo systemctl restart jsonviewer`。

`deploy/jsonviewer.service` 默认以 `jsonviewer` 用户运行，并开启了较严格的安全加固（`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp` 等）。如果要监听 1024 以下的特权端口（如 80/443），需要在 unit 文件中取消下面这一行的注释，否则非 root 用户无法绑定该端口：

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

## 登录验证（可选）

默认不需要登录。设置 `auth = true`（或加 `--auth` 参数）后启用登录验证；用户数据保存在 `users_file` 指定的 JSON 文件里，不设置时默认为配置文件同目录下的 `users.json`（未使用 `-c`/`--config` 时为当前目录下的 `users.json`）。

**首次设置**：启用后首次访问任意页面会跳转到 `/setup`，填写管理员用户名（默认 `admin`，可改）和密码即可创建管理员并自动登录。之后未登录访问会跳转到 `/login`。用户名 1–32 个字符，仅限字母、数字和 `_ . -`，区分大小写，创建后不可修改；密码最少 6 个字符。

**账户与用户管理**：登录后，中栏「视图」面板标题栏右侧会出现用户菜单（显示当前用户名，点开下拉菜单）：

- 「修改密码」：在查看器内弹出对话框，需输入当前密码、新密码、确认新密码；修改成功后会使本账户在其它设备上的登录立即失效。
- 「用户管理」/ `/admin/users`：仅管理员可见（非管理员菜单项隐藏），也可直接访问该地址；可新增用户、删除用户、重置他人密码、设置或取消管理员；不能删除自己，也不能删除或降级最后一个管理员。
- 「退出登录」：下拉菜单里的按钮（POST 请求）。

`/admin/users` 这个独立页面顶部也有一条状态栏，显示当前用户，并提供「返回查看器」「用户管理」（仅管理员可见）「退出登录」几个链接/按钮；这些页面（含 `/setup`、`/login`）文案固定为中文。

**会话与安全**：登录状态通过 Cookie 保存，7 天滑动过期（距上次续期超过 1 分钟的访问会自动续期），会话保存在内存中，服务重启后所有人都需要重新登录；删除某用户，或管理员重置了某用户的密码后，该用户的会话会立即失效。登录失败会限速：同一 IP 或同一用户名连续失败 10 次后锁定 60 秒。这里的 IP 默认取自直连的 TCP 连接地址；只有当连接来源在配置文件的 `trusted_proxies` 列表里时，才会改用 `X-Forwarded-For`/`X-Real-IP` 头判断的真实客户端 IP（见下文「反向代理」一节）——反代后不设置这一项，限速会把所有人都算成反代自身的 IP，可能导致所有人都被锁住。登录、登出、新增/删除用户、重置密码、修改管理员权限等操作都会记录到日志（journal）。用户文件权限固定为 `0600`，只保存密码的 PBKDF2-SHA256（21 万次迭代）哈希，不保存明文密码。（顺带一提：查看器里粘贴的 JSON 内容始终只保存在浏览器本地、不会上传服务器，这与是否启用登录验证无关。）

**CSRF 与静态资源缓存**：写操作使用双提交 CSRF 令牌（HttpOnly Cookie + 表单隐藏字段）防护，不依赖 `Origin`/`Referer`/`Host`，反向代理改写这些请求头也不受影响，无需额外配置。静态资源使用 ETag 协商缓存，升级后浏览器会自动获取新版本，无需手动清缓存。

**忘记密码时恢复**：

```bash
echo '新密码' | sudo -u jsonviewer jsonviewer -c /etc/jsonviewer/jsonviewer.conf --reset-password admin
```

`--reset-password` 把新密码写入用户文件后立即退出；省略 `echo '新密码' |` 会在终端交互提示输入。服务运行中执行该命令会自动生效（服务检测到用户文件被外部改写后自动重新加载），**不需要重启**。删除 `users.json` 后重启服务、回到 `/setup` 重新创建管理员的方式则仍需要重启服务。

**部署注意事项**：启用 `auth` 后，进程需要能写入 `users_file` 所在目录（首次启动会在该目录创建空的 `users.json`）。`deploy/jsonviewer.service` 已包含 `ReadWritePaths=/etc/jsonviewer`；一键安装脚本会把 `/etc/jsonviewer` 属主设为 `jsonviewer:jsonviewer` 并 `chmod 0750`，因此用一键安装启用登录验证无需额外操作。手动安装（见下文"手动安装"）需要自行执行 `sudo chown jsonviewer:jsonviewer /etc/jsonviewer`，否则服务会因无法写入用户文件而启动失败。

## 反向代理

推荐直接以仓库自带的 `deploy/nginx.conf.example`（GitHub Release 附件里也有一份）作为起点：内含 HTTP（80）到 HTTPS（443）的跳转、证书路径（Let's Encrypt 与自签名两种写法，对应命令在文件注释里）、TLS 参数、gzip 压缩，以及根路径与子路径两种 `location` 写法（用哪种取决于 jsonviewer 的 `base_path`）。复制一份，按注释填好域名和证书路径，`nginx -t && systemctl reload nginx` 即可生效。

若挂在子路径下（而不是直接用域名根路径访问），需要将 `base_path` 设置为对应的子路径（例如 `/jsonviewer`），保证前端资源引用的路径与代理路径一致。

建议把 jsonviewer 的 `listen` 改为 `127.0.0.1:8080`，使其只能通过 Nginx 访问，不能被绕过直连。

最小反代 `location` 片段（后端监听 `127.0.0.1:8080`，`base_path = /`）：

```nginx
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_set_header   Host              $http_host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

启用登录验证（`auth = true`）时，还需要在 jsonviewer 配置文件里设置 `trusted_proxies = 127.0.0.1`（反代与 jsonviewer 不在同一台机器时改成反代的真实地址，多个来源用逗号分隔），jsonviewer 才会信任上面设置的 `X-Real-IP`/`X-Forwarded-For`。不设置的话，登录限速会把所有访问者都算作反代自身的 IP（如 `127.0.0.1`），一个人登录失败次数过多会连带锁住所有共用该地址的人。

**关于剪贴板复制**：浏览器的 Clipboard API（`navigator.clipboard`）只在 HTTPS 或 `localhost` 环境下可用。如果通过 HTTP 反向代理对外访问（非 `localhost`），页面会自动降级使用 `document.execCommand('copy')` 方案，复制功能依然可用，但建议尽量配置 HTTPS（见上文 `--tls-cert` / `--tls-key` 参数）以获得更好的兼容性。

## 重建前端依赖（可选）

前端使用的第三方打包产物已经提交在 `web/js/vendor/` 下，日常构建 Go 二进制（`make build`）不需要 Node 环境。只有在升级依赖或修改 `web-src/` 下的入口文件时才需要重新打包：

```bash
npm install
npm run build:vendor   # 一次生成全部三个产物
```

也可以单独重建其中一个：

| 脚本 | 入口 | 产物 |
| --- | --- | --- |
| `npm run build:cm` | `web-src/codemirror-entry.js` | `web/js/vendor/codemirror.bundle.js`（CodeMirror 6，含 JSON / YAML / XML / TOML 高亮） |
| `npm run build:yaml` | `web-src/yaml-entry.js` | `web/js/vendor/yaml.bundle.js`（js-yaml） |
| `npm run build:toml` | `web-src/toml-entry.js` | `web/js/vendor/toml.bundle.js`（smol-toml） |

YAML 与 TOML 解析库按需懒加载：首次识别到 YAML / TOML，或选其为转换目标时才请求对应的包，纯 JSON 会话不会请求它们。XML 用浏览器原生 `DOMParser`，没有对应的包。之后正常 `make build` 即可把新产物打进二进制。

## 致谢与许可

- 三栏布局与中间栏树视图的图标风格参考自 [bejson.com](https://www.bejson.com/) 的 jsonviewer（基于 ExtJS 3 实现）。
- 编辑器使用 [CodeMirror 6](https://codemirror.net/)，遵循 MIT 协议。
- YAML 解析与输出使用 [js-yaml](https://github.com/nodeca/js-yaml)（MIT）；TOML 使用 [smol-toml](https://github.com/squirrelchat/smol-toml)（BSD-3-Clause）。
- 本项目使用 MIT 许可证（见 LICENSE）。
</content>
</invoke>
