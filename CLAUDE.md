# jsonviewer

自托管的 JSON 在线视图查看器，复刻 bejson.com/jsonviewernew 的三栏布局与功能（无广告、无统计）。

## 结构
- `main.go`：Go 标准库 HTTP 服务，`//go:embed web` 把前端打进单一二进制；参数与配置文件见 `-h` / `deploy/jsonviewer.conf`。
- `web/`：前端。`index.html`、`css/style.css`、`js/app.js`（原生 JS，无框架）、`js/vendor/codemirror.bundle.js`（已打包的 CodeMirror 6）、`assets/ico/`（ExtJS 风格树图标）。
- `web-src/codemirror-entry.js` + `package.json`：重建 CodeMirror 打包产物用（`npm i && npm run build:cm`），日常构建不需要 Node。
- `deploy/`：systemd 单元与示例配置。`Makefile`：`make build` / `make release`。

## 约定
- 树视图（中间栏）样式保持 ExtJS 原样：18px 行高、11px arial、连接线与加减号图标、选中色 #d9e8fb。其他区域是清爽主题，可以自由调整。
- 性能是硬性要求：树视图必须保持虚拟滚动，节点懒创建；编辑器用 CodeMirror（textarea 在大文本下不可用）；解析走原生 JSON.parse 快速路径，只有出现 16 位以上数字才走大数保护。
- Go 只用标准库。前端不引框架、不走 CDN。
- 验证：`make build` 后运行二进制，用 headless Chrome（puppeteer-core + 本机 google-chrome）跑功能与大 JSON 性能测试。

## 模型分工（子代理）
- 规划、设计、方案取舍、评审 → `architect`（Fable，只读顾问）。非平凡改动先让它出方案。
- 编码实现、修 bug、重构 → `coder`（Opus）。主会话默认模型也是 Opus（.claude/settings.json）。
- README、部署文档、配置说明等 → `doc-writer`（Sonnet）。
- 跑测试/构建、git commit/push 等确定性操作 → `ops`（Haiku）。
- 主会话遇到需要深入思考的规划问题时使用 advisor（advisorModel = fable）。
