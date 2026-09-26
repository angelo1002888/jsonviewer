// jsonviewer: 自托管的 JSON 在线视图查看器，静态资源打包在二进制内。
package main

import (
	"bufio"
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

var version = "dev" // 由 -ldflags "-X main.version=..." 注入

// Config 是全部可配置项。优先级：命令行参数 > 配置文件 > 默认值。
type Config struct {
	Listen    string // 监听地址，如 :8080 或 127.0.0.1:8080
	BasePath  string // 反向代理到子路径时使用，如 /jsonviewer
	AccessLog bool   // 是否打印访问日志
	TLSCert   string // 证书文件；与 TLSKey 同时设置则启用 HTTPS
	TLSKey    string
	Auth      bool   // 是否启用登录验证
	UsersFile string // 用户文件路径（启用登录验证时使用）
}

func defaultConfig() Config {
	return Config{Listen: ":8080", BasePath: "/", AccessLog: false}
}

const exampleConfig = `# jsonviewer 配置文件（key = value，# 开头为注释）
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
`

// loadConfigFile 读取 key = value 格式的配置文件。
func loadConfigFile(path string, cfg *Config) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s:%d: 缺少 '='", path, lineNo)
		}
		key = strings.ToLower(strings.TrimSpace(key))
		val = strings.TrimSpace(val)
		if err := applyOption(cfg, key, val); err != nil {
			return fmt.Errorf("%s:%d: %w", path, lineNo, err)
		}
	}
	return sc.Err()
}

func applyOption(cfg *Config, key, val string) error {
	switch strings.ReplaceAll(key, "-", "_") {
	case "listen":
		cfg.Listen = val
	case "base_path":
		cfg.BasePath = val
	case "access_log":
		b, err := strconv.ParseBool(val)
		if err != nil {
			return fmt.Errorf("access_log 需要 true/false: %q", val)
		}
		cfg.AccessLog = b
	case "tls_cert":
		cfg.TLSCert = val
	case "tls_key":
		cfg.TLSKey = val
	case "auth":
		b, err := strconv.ParseBool(val)
		if err != nil {
			return fmt.Errorf("auth 需要 true/false: %q", val)
		}
		cfg.Auth = b
	case "users_file":
		cfg.UsersFile = val
	default:
		return fmt.Errorf("未知配置项 %q", key)
	}
	return nil
}

func normalizeBasePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if p != "/" {
		p = strings.TrimSuffix(p, "/")
	}
	return p
}

func main() {
	cfg := defaultConfig()

	var (
		configPath    string
		showVersion   bool
		exampleOnly   bool
		flagListen    string
		flagBasePath  string
		flagAccessLog bool
		flagTLSCert   string
		flagTLSKey    string
		flagAuth      bool
		flagUsersFile string
		resetUser     string
	)
	// 长短名绑定同一个变量；flag 包同时接受 -name 与 --name。
	for _, name := range []string{"l", "listen"} {
		flag.StringVar(&flagListen, name, cfg.Listen, "监听地址")
	}
	for _, name := range []string{"b", "base-path"} {
		flag.StringVar(&flagBasePath, name, cfg.BasePath, "反向代理子路径")
	}
	for _, name := range []string{"a", "access-log"} {
		flag.BoolVar(&flagAccessLog, name, cfg.AccessLog, "打印访问日志")
	}
	flag.StringVar(&flagTLSCert, "tls-cert", "", "TLS 证书文件")
	flag.StringVar(&flagTLSKey, "tls-key", "", "TLS 私钥文件")
	flag.BoolVar(&flagAuth, "auth", false, "启用登录验证")
	flag.StringVar(&flagUsersFile, "users-file", "", "用户文件路径")
	flag.StringVar(&resetUser, "reset-password", "", "重置指定用户的密码并退出")
	for _, name := range []string{"c", "config"} {
		flag.StringVar(&configPath, name, "", "配置文件路径")
	}
	for _, name := range []string{"v", "version"} {
		flag.BoolVar(&showVersion, name, false, "显示版本并退出")
	}
	for _, name := range []string{"e", "example-config"} {
		flag.BoolVar(&exampleOnly, name, false, "输出示例配置文件并退出")
	}
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "用法: %s [参数]\n\n", filepath.Base(os.Args[0]))
		fmt.Fprint(os.Stderr, `  -l, --listen <addr>       监听地址，例如 :8080 或 127.0.0.1:8080（默认 :8080）
  -b, --base-path <path>    反向代理子路径，例如 /jsonviewer（默认 /）
  -a, --access-log          打印访问日志
      --tls-cert <file>     TLS 证书文件（与 --tls-key 同时使用启用 HTTPS）
      --tls-key <file>      TLS 私钥文件
      --auth                启用登录验证（首次访问进入 /setup 设置管理员）
      --users-file <file>   用户文件（默认为配置文件同目录下的 users.json）
      --reset-password <user>
                            重置该用户的密码（新密码从标准输入读取）并退出
  -c, --config <file>       配置文件路径（key = value 格式）
  -e, --example-config      输出示例配置文件并退出
  -v, --version             显示版本并退出
  -h, --help                显示本帮助

优先级：命令行参数 > 配置文件 > 默认值
`)
	}
	flag.Parse()

	if showVersion {
		fmt.Println("jsonviewer", version)
		return
	}
	if exampleOnly {
		fmt.Print(exampleConfig)
		return
	}

	// 1. 配置文件
	if configPath != "" {
		if err := loadConfigFile(configPath, &cfg); err != nil {
			log.Fatalf("读取配置文件失败: %v", err)
		}
	}
	// 2. 命令行中显式指定的参数覆盖配置文件（短名与长名指向同一个设置函数）
	setListen := func() { cfg.Listen = flagListen }
	setBasePath := func() { cfg.BasePath = flagBasePath }
	setAccessLog := func() { cfg.AccessLog = flagAccessLog }
	overrides := map[string]func(){
		"l": setListen, "listen": setListen,
		"b": setBasePath, "base-path": setBasePath,
		"a": setAccessLog, "access-log": setAccessLog,
		"tls-cert":   func() { cfg.TLSCert = flagTLSCert },
		"tls-key":    func() { cfg.TLSKey = flagTLSKey },
		"auth":       func() { cfg.Auth = flagAuth },
		"users-file": func() { cfg.UsersFile = flagUsersFile },
	}
	flag.Visit(func(f *flag.Flag) {
		if set, ok := overrides[f.Name]; ok {
			set()
		}
	})
	cfg.BasePath = normalizeBasePath(cfg.BasePath)
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		log.Fatal("tls_cert 与 tls_key 必须同时设置")
	}
	if cfg.UsersFile == "" {
		if configPath != "" {
			cfg.UsersFile = filepath.Join(filepath.Dir(configPath), "users.json")
		} else {
			cfg.UsersFile = "users.json"
		}
	}

	if resetUser != "" {
		if err := resetPassword(cfg.UsersFile, resetUser); err != nil {
			fmt.Fprintln(os.Stderr, "错误:", err)
			os.Exit(1)
		}
		return
	}

	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}

func run(cfg Config) error {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		return err
	}
	var auth *authServer
	if cfg.Auth {
		users, err := loadUsers(cfg.UsersFile)
		if err != nil {
			return err
		}
		if _, err := os.Stat(cfg.UsersFile); errors.Is(err, os.ErrNotExist) {
			// 立即写入空结构：目录不可写时在启动阶段就失败，而不是等到 /setup。
			if err := users.save(); err != nil {
				return fmt.Errorf("auth 已启用但无法写入 %s: %w", cfg.UsersFile, err)
			}
		}
		if auth, err = newAuthServer(cfg, users); err != nil {
			return err
		}
	}
	handler := newHandler(sub, cfg, auth)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", cfg.Listen, err)
	}

	scheme := "http"
	if cfg.TLSCert != "" {
		scheme = "https"
	}
	log.Printf("jsonviewer %s 已启动: %s://%s%s", version, scheme, displayAddr(ln.Addr()), cfg.BasePath)
	if auth != nil {
		log.Printf("登录验证: 已启用（用户文件 %s）", cfg.UsersFile)
	}

	errCh := make(chan error, 1)
	go func() {
		var e error
		if cfg.TLSCert != "" {
			e = srv.ServeTLS(ln, cfg.TLSCert, cfg.TLSKey)
		} else {
			e = srv.Serve(ln)
		}
		if !errors.Is(e, http.ErrServerClosed) {
			errCh <- e
		}
		close(errCh)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case e := <-errCh:
		return e
	case sig := <-stop:
		log.Printf("收到 %s，正在退出...", sig)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(ctx)
}

func displayAddr(a net.Addr) string {
	s := a.String()
	if strings.HasPrefix(s, "[::]:") {
		return "localhost" + s[4:]
	}
	if strings.HasPrefix(s, "0.0.0.0:") {
		return "localhost" + s[7:]
	}
	return s
}

// newHandler 返回静态文件服务，支持 base_path 前缀、登录验证与访问日志。
// 顺序：accessLog → base_path StripPrefix → requireLogin → 内层路由。
func newHandler(root fs.FS, cfg Config, auth *authServer) http.Handler {
	files := http.FileServer(http.FS(root))
	static := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			h.Set("Cache-Control", "no-cache")
		} else {
			h.Set("Cache-Control", "public, max-age=3600")
		}
		files.ServeHTTP(w, r)
	})

	var h http.Handler
	if auth != nil {
		inner := http.NewServeMux()
		auth.register(inner)
		inner.Handle("/", static)
		h = auth.requireLogin(inner)
	} else {
		// 未启用登录验证：除 /api/me 外与原来的静态服务完全一致（不经过 ServeMux 的路径规范化）。
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/me" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
				apiMeDisabled(w, r)
				return
			}
			static.ServeHTTP(w, r)
		})
	}
	if cfg.BasePath != "/" {
		app := h
		mux := http.NewServeMux()
		mux.Handle(cfg.BasePath+"/", http.StripPrefix(cfg.BasePath, app))
		mux.HandleFunc(cfg.BasePath, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, cfg.BasePath+"/", http.StatusMovedPermanently)
		})
		h = mux
	}
	if cfg.AccessLog {
		h = accessLog(h)
	}
	return h
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %s %d %s", r.RemoteAddr, r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Microsecond))
	})
}

// resetPassword 实现 --reset-password：从标准输入读取新密码并写回用户文件。
func resetPassword(usersFile, name string) error {
	users, err := loadUsers(usersFile)
	if err != nil {
		return err
	}
	if _, ok := users.find(name); !ok {
		return fmt.Errorf("用户文件 %s 中不存在用户 %q（如需重新初始化，可删除该文件后重启服务，访问 /setup 重新创建管理员）", usersFile, name)
	}
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
		fmt.Fprint(os.Stderr, "新密码: ")
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && line != "") {
		return fmt.Errorf("读取新密码失败: %w", err)
	}
	pw := strings.TrimRight(line, "\r\n")
	if len(pw) < minPasswordLen {
		return fmt.Errorf("密码至少 %d 个字符", minPasswordLen)
	}
	if len(pw) > maxPasswordLen {
		return errPasswordTooLong
	}
	if err := users.setPassword(name, pw); err != nil {
		return err
	}
	if err := users.save(); err != nil {
		return fmt.Errorf("保存用户文件 %s 失败: %w", usersFile, err)
	}
	fmt.Printf("已重置用户 %s 的密码，已生效，无需重启服务。\n", name)
	return nil
}
