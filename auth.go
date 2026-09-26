package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed templates
var templatesFS embed.FS

const (
	sessionCookieName    = "jsonviewer_session"
	csrfCookieName       = "jsonviewer_csrf"
	sessionTTL           = 7 * 24 * time.Hour
	sessionTouchInterval = time.Minute
	loginMaxFails        = 10
	loginLockDuration    = 60 * time.Second
	loginFailWindow      = 15 * time.Minute
	maxFormBytes         = 64 << 10
)

// ---------- 会话 ----------

type session struct {
	User      string
	Expires   time.Time
	LastTouch time.Time
}

type sessionStore struct {
	mu sync.Mutex
	m  map[string]*session
}

func newSessionStore() *sessionStore {
	return &sessionStore{m: make(map[string]*session)}
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// create 新建会话，并顺手清理过期项。
func (s *sessionStore) create(user string) string {
	now := time.Now()
	tok := newToken()
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.m {
		if now.After(v.Expires) {
			delete(s.m, k)
		}
	}
	s.m[tok] = &session{User: user, Expires: now.Add(sessionTTL), LastTouch: now}
	return tok
}

// get 返回会话所属用户；touched 表示本次续期了（调用方据此刷新 Cookie）。
func (s *sessionStore) get(tok string) (user string, touched, ok bool) {
	if tok == "" {
		return "", false, false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	se := s.m[tok]
	if se == nil {
		return "", false, false
	}
	if now.After(se.Expires) {
		delete(s.m, tok)
		return "", false, false
	}
	if now.Sub(se.LastTouch) > sessionTouchInterval {
		se.LastTouch = now
		se.Expires = now.Add(sessionTTL)
		touched = true
	}
	return se.User, touched, true
}

func (s *sessionStore) remove(tok string) {
	s.mu.Lock()
	delete(s.m, tok)
	s.mu.Unlock()
}

func (s *sessionStore) revokeUser(name string) {
	s.revokeUserExcept(name, "")
}

func (s *sessionStore) revokeUserExcept(name, keep string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.m {
		if v.User == name && k != keep {
			delete(s.m, k)
		}
	}
}

// ---------- 登录限速 ----------

type limitEntry struct {
	fails int
	until time.Time
	last  time.Time
}

type loginLimiter struct {
	mu sync.Mutex
	m  map[string]*limitEntry
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{m: make(map[string]*limitEntry)}
}

func (l *loginLimiter) blocked(keys ...string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		if e := l.m[k]; e != nil && now.Before(e.until) {
			return true
		}
	}
	return false
}

func (l *loginLimiter) fail(keys ...string) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) > 10000 {
		for k, e := range l.m {
			if now.After(e.until) && now.Sub(e.last) > loginFailWindow {
				delete(l.m, k)
			}
		}
	}
	for _, k := range keys {
		e := l.m[k]
		if e == nil {
			e = &limitEntry{}
			l.m[k] = e
		}
		if now.Sub(e.last) > loginFailWindow {
			e.fails = 0
		}
		e.last = now
		e.fails++
		if e.fails >= loginMaxFails {
			e.fails = 0
			e.until = now.Add(loginLockDuration)
		}
	}
}

func (l *loginLimiter) reset(keys ...string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, k := range keys {
		delete(l.m, k)
	}
}

// ---------- CSRF ----------

// 双提交令牌：jsonviewer_csrf Cookie（HttpOnly）的值同时写进表单隐藏字段 csrf，
// POST 时两者必须一致。不依赖 Origin/Referer/Host（非安全上下文下 Origin 可能为 null，
// 反向代理也可能改写 Host），跨站页面读不到 Cookie 值，因而无法伪造表单字段。

// fetchSiteOK：有 Sec-Fetch-Site 时拒绝 cross-site 与 same-site；缺失（旧浏览器、非安全上下文）则放行，交由令牌校验。
func fetchSiteOK(r *http.Request) bool {
	sfs := r.Header.Get("Sec-Fetch-Site")
	return sfs != "cross-site" && sfs != "same-site"
}

func csrfCookie(r *http.Request) string {
	c, err := r.Cookie(csrfCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// csrfTokenOK 比较表单字段 csrf 与 Cookie 值（调用前须已 ParseForm）。
func csrfTokenOK(r *http.Request) bool {
	form, cookie := r.PostFormValue("csrf"), csrfCookie(r)
	return form != "" && cookie != "" && subtle.ConstantTimeCompare([]byte(form), []byte(cookie)) == 1
}

// ensureCSRF 返回当前请求的 CSRF 令牌；请求未携带时生成新令牌并 Set-Cookie。
// 同一请求内只调用一次（刚设置的 Cookie 在 r 上读不到）。
func (a *authServer) ensureCSRF(w http.ResponseWriter, r *http.Request) string {
	if tok := csrfCookie(r); tok != "" {
		return tok
	}
	tok := newToken()
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    tok,
		Path:     a.cookiePath(),
		MaxAge:   int(sessionTTL / time.Second),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.secure(r),
	})
	return tok
}

// checkCSRF 对非 GET/HEAD 请求做 CSRF 校验；失败时已写出 403 响应并返回 false。
func (a *authServer) checkCSRF(w http.ResponseWriter, r *http.Request) bool {
	if !fetchSiteOK(r) {
		log.Printf("拒绝跨站请求: %s %s from %s (Sec-Fetch-Site=%q)", r.Method, r.URL.Path, a.clientIP(r), r.Header.Get("Sec-Fetch-Site"))
		a.forbidden(w, r, "跨站请求被拒绝")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	if !csrfTokenOK(r) {
		log.Printf("CSRF 令牌缺失或不匹配: %s %s from %s", r.Method, r.URL.Path, a.clientIP(r))
		a.forbidden(w, r, "表单已过期，请刷新页面后重试")
		return false
	}
	return true
}

// forbidden 输出 403：浏览器页面请求用认证页样式，其余返回纯文本。
func (a *authServer) forbidden(w http.ResponseWriter, r *http.Request, msg string) {
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		a.render(w, r, http.StatusForbidden, "message.html", pageData{Title: "请求被拒绝", Error: msg})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "403 forbidden: "+msg, http.StatusForbidden)
}

// ---------- authServer ----------

type authServer struct {
	cfg       Config
	base      string // 以 / 结尾的站点根，如 "/" 或 "/jv/"
	users     *userStore
	sessions  *sessionStore
	limiter   *loginLimiter
	proxies   trustedProxies
	sem       chan struct{} // 限制并发 PBKDF2 计算
	dummyHash string
	tmpl      map[string]*template.Template
}

type ctxUserKey struct{}

type userRow struct {
	Name    string
	Admin   bool
	Created string
	Self    bool
}

type pageData struct {
	Base     string
	Title    string
	Wide     bool
	User     string
	Admin    bool
	Error    string
	Notice   string
	CSRF     string
	Username string
	Users    []userRow
}

// siteBase 返回以 / 结尾的根路径："/" -> "/"，"/jv" -> "/jv/"。
func siteBase(basePath string) string {
	if basePath == "" || basePath == "/" {
		return "/"
	}
	return strings.TrimSuffix(basePath, "/") + "/"
}

func newAuthServer(cfg Config, users *userStore) (*authServer, error) {
	proxies, err := parseTrustedProxies(cfg.TrustedProxies)
	if err != nil {
		return nil, err
	}
	a := &authServer{
		cfg:       cfg,
		base:      siteBase(cfg.BasePath),
		users:     users,
		sessions:  newSessionStore(),
		limiter:   newLoginLimiter(),
		proxies:   proxies,
		sem:       make(chan struct{}, 4),
		dummyHash: hashPassword("jsonviewer-dummy-password"),
		tmpl:      make(map[string]*template.Template),
	}
	for _, page := range []string{"login.html", "setup.html", "users.html", "message.html"} {
		t, err := template.New("").ParseFS(templatesFS, "templates/layout.html", "templates/"+page)
		if err != nil {
			return nil, err
		}
		a.tmpl[page] = t
	}
	return a, nil
}

// withSem 在信号量保护下执行 PBKDF2 相关计算。
func (a *authServer) withSem(fn func()) {
	a.sem <- struct{}{}
	defer func() { <-a.sem }()
	fn()
}

func (a *authServer) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /setup", a.getSetup)
	mux.HandleFunc("POST /setup", a.postSetup)
	mux.HandleFunc("GET /login", a.getLogin)
	mux.HandleFunc("POST /login", a.postLogin)
	mux.HandleFunc("POST /logout", a.postLogout)
	mux.HandleFunc("GET /admin/users", a.adminOnly(a.getUsers))
	mux.HandleFunc("POST /admin/users/add", a.adminOnly(a.postUserAdd))
	mux.HandleFunc("POST /admin/users/delete", a.adminOnly(a.postUserDelete))
	mux.HandleFunc("POST /admin/users/password", a.adminOnly(a.postUserPassword))
	mux.HandleFunc("POST /admin/users/admin", a.adminOnly(a.postUserAdmin))
	mux.HandleFunc("GET /api/me", a.apiMe)
	mux.HandleFunc("POST /api/password", a.apiPassword)
}

// apiMeDisabled 用于未启用登录验证时。
func apiMeDisabled(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"auth": false})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// clientIP 返回经 trusted_proxies 判定后的客户端地址。
func (a *authServer) clientIP(r *http.Request) string { return a.proxies.clientIP(r) }

func (a *authServer) secure(r *http.Request) bool {
	return a.cfg.TLSCert != "" || r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (a *authServer) cookiePath() string {
	if a.cfg.BasePath == "" {
		return "/"
	}
	return a.cfg.BasePath
}

func (a *authServer) setSessionCookie(w http.ResponseWriter, r *http.Request, tok string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    tok,
		Path:     a.cookiePath(),
		MaxAge:   int(sessionTTL / time.Second),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.secure(r),
	})
}

func (a *authServer) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     a.cookiePath(),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.secure(r),
	})
}

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// currentUser 解析会话 Cookie；会话续期时同时刷新 Cookie 的有效期。
func (a *authServer) currentUser(w http.ResponseWriter, r *http.Request) (User, bool) {
	tok := sessionToken(r)
	name, touched, ok := a.sessions.get(tok)
	if !ok {
		return User{}, false
	}
	u, ok := a.users.find(name)
	if !ok {
		a.sessions.revokeUser(name)
		return User{}, false
	}
	if touched {
		a.setSessionCookie(w, r, tok)
	}
	return u, true
}

func userFromContext(r *http.Request) (User, bool) {
	u, ok := r.Context().Value(ctxUserKey{}).(User)
	return u, ok
}

func (a *authServer) redirect(w http.ResponseWriter, r *http.Request, rel string) {
	http.Redirect(w, r, a.base+rel, http.StatusFound)
}

// requireLogin：POST 先做 CSRF 校验；公开路径直接放行；其余要求已登录。
func (a *authServer) requireLogin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !a.checkCSRF(w, r) {
			return
		}
		// 每个请求先检查用户文件是否被外部修改（如运行中执行 --reset-password），
		// 保证后续读取与保存都基于最新数据，不会覆盖外部改动。
		a.users.reloadIfChanged()
		p := r.URL.Path
		if p == "/login" || p == "/setup" || p == "/api/me" || strings.HasPrefix(p, "/css/") || strings.HasPrefix(p, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}
		u, ok := a.currentUser(w, r)
		if !ok {
			// 接口请求返回 JSON 401（由前端跳转登录页），不做重定向
			if strings.HasPrefix(p, "/api/") {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "未登录或登录已过期"})
				return
			}
			if a.users.count() == 0 {
				a.redirect(w, r, "setup")
			} else {
				a.redirect(w, r, "login")
			}
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxUserKey{}, u)))
	})
}

func (a *authServer) adminOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := userFromContext(r)
		if !ok || !u.Admin {
			w.Header().Set("Cache-Control", "no-store")
			http.Error(w, "403 forbidden: 需要管理员权限", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

func (a *authServer) render(w http.ResponseWriter, r *http.Request, status int, page string, d pageData) {
	d.Base = a.base
	d.CSRF = a.ensureCSRF(w, r)
	var buf bytes.Buffer
	if err := a.tmpl[page].ExecuteTemplate(&buf, "layout", d); err != nil {
		log.Printf("渲染模板 %s 失败: %v", page, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "same-origin")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func parseForm(w http.ResponseWriter, r *http.Request) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	return true
}

// checkNewPassword 校验新密码长度与两次输入一致。
func checkNewPassword(pw, confirm string) string {
	if len(pw) < minPasswordLen {
		return "密码至少 " + strconv.Itoa(minPasswordLen) + " 个字符"
	}
	if len(pw) > maxPasswordLen {
		return errPasswordTooLong.Error()
	}
	if pw != confirm {
		return "两次输入的密码不一致"
	}
	return ""
}

// ---------- /setup ----------

func (a *authServer) getSetup(w http.ResponseWriter, r *http.Request) {
	if a.users.count() != 0 {
		a.redirect(w, r, "login")
		return
	}
	a.render(w, r, http.StatusOK, "setup.html", pageData{Title: "初始设置：创建管理员", Username: "admin"})
}

func (a *authServer) postSetup(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	if a.users.count() != 0 {
		a.redirect(w, r, "login")
		return
	}
	name := strings.TrimSpace(r.PostFormValue("username"))
	pw := r.PostFormValue("password")
	d := pageData{Title: "初始设置：创建管理员", Username: name}
	if !validUsername(name) {
		d.Error = errInvalidName.Error()
		a.render(w, r, http.StatusBadRequest, "setup.html", d)
		return
	}
	if msg := checkNewPassword(pw, r.PostFormValue("confirm")); msg != "" {
		d.Error = msg
		a.render(w, r, http.StatusBadRequest, "setup.html", d)
		return
	}
	var err error
	a.withSem(func() { err = a.users.setupAdmin(name, pw) })
	if errors.Is(err, errAlreadySetup) {
		a.redirect(w, r, "login")
		return
	}
	if err != nil {
		log.Printf("setup: 保存用户文件失败: %v", err)
		d.Error = "保存用户文件失败: " + err.Error()
		a.render(w, r, http.StatusInternalServerError, "setup.html", d)
		return
	}
	log.Printf("setup: 已创建管理员 %s (from %s)", name, a.clientIP(r))
	a.setSessionCookie(w, r, a.sessions.create(name))
	a.redirect(w, r, "")
}

// ---------- /login /logout ----------

func (a *authServer) getLogin(w http.ResponseWriter, r *http.Request) {
	if a.users.count() == 0 {
		a.redirect(w, r, "setup")
		return
	}
	if _, ok := a.currentUser(w, r); ok {
		a.redirect(w, r, "")
		return
	}
	a.render(w, r, http.StatusOK, "login.html", pageData{Title: "登录"})
}

func (a *authServer) postLogin(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	if a.users.count() == 0 {
		a.redirect(w, r, "setup")
		return
	}
	name := strings.TrimSpace(r.PostFormValue("username"))
	pw := r.PostFormValue("password")
	d := pageData{Title: "登录", Username: name}
	keys := []string{"ip:" + a.clientIP(r), "user:" + name}
	if a.limiter.blocked(keys...) {
		log.Printf("登录被限速: 用户 %q (from %s)", name, a.clientIP(r))
		d.Error = "尝试次数过多，请 1 分钟后再试"
		a.render(w, r, http.StatusTooManyRequests, "login.html", d)
		return
	}
	u, found := a.users.find(name)
	hash := a.dummyHash
	if found {
		hash = u.PasswordHash
	}
	var ok bool
	a.withSem(func() { ok = verifyPassword(hash, pw) })
	if !found || !ok {
		a.limiter.fail(keys...)
		log.Printf("登录失败: 用户 %q (from %s)", name, a.clientIP(r))
		d.Error = "用户名或密码错误"
		a.render(w, r, http.StatusUnauthorized, "login.html", d)
		return
	}
	a.limiter.reset(keys...)
	log.Printf("登录成功: 用户 %s (from %s)", name, a.clientIP(r))
	a.setSessionCookie(w, r, a.sessions.create(name))
	a.redirect(w, r, "")
}

func (a *authServer) postLogout(w http.ResponseWriter, r *http.Request) {
	if tok := sessionToken(r); tok != "" {
		a.sessions.remove(tok)
	}
	u, _ := userFromContext(r)
	log.Printf("登出: 用户 %s (from %s)", u.Name, a.clientIP(r))
	a.clearSessionCookie(w, r)
	a.redirect(w, r, "login")
}

// ---------- /admin/users ----------

func (a *authServer) usersPage(u User) pageData {
	d := pageData{Title: "用户管理", Wide: true, User: u.Name, Admin: u.Admin}
	for _, x := range a.users.list() {
		d.Users = append(d.Users, userRow{
			Name:    x.Name,
			Admin:   x.Admin,
			Created: x.CreatedAt.Local().Format("2006-01-02 15:04:05"),
			Self:    x.Name == u.Name,
		})
	}
	return d
}

// usersResult 重新渲染用户列表，并附带操作结果。
func (a *authServer) usersResult(w http.ResponseWriter, r *http.Request, errMsg, notice string) {
	u, _ := userFromContext(r)
	if cur, ok := a.users.find(u.Name); ok {
		u = cur
	}
	if !u.Admin {
		a.redirect(w, r, "")
		return
	}
	d := a.usersPage(u)
	d.Error, d.Notice = errMsg, notice
	status := http.StatusOK
	if errMsg != "" {
		status = http.StatusBadRequest
	}
	a.render(w, r, status, "users.html", d)
}

func (a *authServer) getUsers(w http.ResponseWriter, r *http.Request) {
	a.usersResult(w, r, "", "")
}

func (a *authServer) postUserAdd(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	me, _ := userFromContext(r)
	name := strings.TrimSpace(r.PostFormValue("username"))
	pw := r.PostFormValue("password")
	admin := r.PostFormValue("admin") != ""
	if !validUsername(name) {
		a.usersResult(w, r, errInvalidName.Error(), "")
		return
	}
	if len(pw) < minPasswordLen {
		a.usersResult(w, r, "密码至少 "+strconv.Itoa(minPasswordLen)+" 个字符", "")
		return
	}
	var err error
	a.withSem(func() { err = a.users.add(name, pw, admin) })
	if err == nil {
		err = a.users.save()
	}
	if err != nil {
		a.usersResult(w, r, err.Error(), "")
		return
	}
	log.Printf("用户管理: %s 新增用户 %s (admin=%v) (from %s)", me.Name, name, admin, a.clientIP(r))
	a.usersResult(w, r, "", "已新增用户 "+name)
}

func (a *authServer) postUserDelete(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	me, _ := userFromContext(r)
	name := r.PostFormValue("name")
	if name == me.Name {
		a.usersResult(w, r, "不能删除自己", "")
		return
	}
	err := a.users.remove(name)
	if err == nil {
		err = a.users.save()
	}
	if err != nil {
		a.usersResult(w, r, err.Error(), "")
		return
	}
	a.sessions.revokeUser(name)
	log.Printf("用户管理: %s 删除用户 %s (from %s)", me.Name, name, a.clientIP(r))
	a.usersResult(w, r, "", "已删除用户 "+name)
}

func (a *authServer) postUserPassword(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	me, _ := userFromContext(r)
	name := r.PostFormValue("name")
	pw := r.PostFormValue("password")
	if msg := checkNewPassword(pw, pw); msg != "" {
		a.usersResult(w, r, msg, "")
		return
	}
	var err error
	a.withSem(func() { err = a.users.setPassword(name, pw) })
	if err == nil {
		err = a.users.save()
	}
	if err != nil {
		a.usersResult(w, r, err.Error(), "")
		return
	}
	if name == me.Name {
		a.sessions.revokeUserExcept(name, sessionToken(r))
	} else {
		a.sessions.revokeUser(name)
	}
	log.Printf("用户管理: %s 重置了用户 %s 的密码 (from %s)", me.Name, name, a.clientIP(r))
	a.usersResult(w, r, "", "已重置用户 "+name+" 的密码")
}

func (a *authServer) postUserAdmin(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	me, _ := userFromContext(r)
	name := r.PostFormValue("name")
	admin, perr := strconv.ParseBool(r.PostFormValue("admin"))
	if perr != nil {
		a.usersResult(w, r, "参数错误", "")
		return
	}
	err := a.users.setAdmin(name, admin)
	if err == nil {
		err = a.users.save()
	}
	if err != nil {
		a.usersResult(w, r, err.Error(), "")
		return
	}
	log.Printf("用户管理: %s 将用户 %s 的管理员权限设为 %v (from %s)", me.Name, name, admin, a.clientIP(r))
	if admin {
		a.usersResult(w, r, "", "已将 "+name+" 设为管理员")
	} else {
		a.usersResult(w, r, "", "已取消 "+name+" 的管理员权限")
	}
}

// ---------- /api/me ----------

func (a *authServer) apiMe(w http.ResponseWriter, r *http.Request) {
	csrf := a.ensureCSRF(w, r)
	u, ok := a.currentUser(w, r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"auth": true, "user": nil, "csrf": csrf})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"auth": true, "user": u.Name, "admin": u.Admin, "csrf": csrf})
}

// ---------- /api/password ----------

// apiPassword 供查看器内"修改密码"弹窗使用：校验当前密码后写入新密码，并撤销该用户的其它会话。
func (a *authServer) apiPassword(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r) {
		return
	}
	u, _ := userFromContext(r)
	fail := func(status int, msg string) {
		writeJSON(w, status, map[string]any{"ok": false, "error": msg})
	}
	cur := r.PostFormValue("current")
	pw := r.PostFormValue("password")
	var ok bool
	a.withSem(func() { ok = verifyPassword(u.PasswordHash, cur) })
	if !ok {
		log.Printf("修改密码失败（当前密码错误）: 用户 %s (from %s)", u.Name, a.clientIP(r))
		fail(http.StatusBadRequest, "当前密码错误")
		return
	}
	switch {
	case len(pw) < minPasswordLen:
		fail(http.StatusBadRequest, "新密码至少 "+strconv.Itoa(minPasswordLen)+" 位")
		return
	case len(pw) > maxPasswordLen:
		fail(http.StatusBadRequest, errPasswordTooLong.Error())
		return
	case pw != r.PostFormValue("confirm"):
		fail(http.StatusBadRequest, "两次输入的新密码不一致")
		return
	}
	var err error
	a.withSem(func() { err = a.users.setPassword(u.Name, pw) })
	if err == nil {
		err = a.users.save()
	}
	if err != nil {
		log.Printf("修改密码失败: 用户 %s: %v", u.Name, err)
		fail(http.StatusInternalServerError, "保存失败: "+err.Error())
		return
	}
	a.sessions.revokeUserExcept(u.Name, sessionToken(r))
	log.Printf("修改密码: 用户 %s (from %s)", u.Name, a.clientIP(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
