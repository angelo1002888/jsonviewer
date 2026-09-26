package main

import (
	"encoding/hex"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPBKDF2RFCVectors(t *testing.T) {
	cases := []struct {
		iter int
		want string
	}{
		{1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
	}
	for _, c := range cases {
		got := hex.EncodeToString(pbkdf2SHA256([]byte("password"), []byte("salt"), c.iter, 32))
		if got != c.want {
			t.Errorf("iter=%d: got %s, want %s", c.iter, got, c.want)
		}
	}
	// 输出长度超过一个块时按块拼接并截断
	if n := len(pbkdf2SHA256([]byte("p"), []byte("s"), 2, 40)); n != 40 {
		t.Errorf("keyLen 40: got %d bytes", n)
	}
}

func TestHashVerify(t *testing.T) {
	h := hashPassword("s3cret-pass")
	if !strings.HasPrefix(h, "pbkdf2-sha256$210000$") || strings.Count(h, "$") != 3 {
		t.Fatalf("unexpected hash format: %s", h)
	}
	if !verifyPassword(h, "s3cret-pass") {
		t.Error("correct password rejected")
	}
	if verifyPassword(h, "s3cret-pasS") {
		t.Error("wrong password accepted")
	}
	if h2 := hashPassword("s3cret-pass"); h2 == h {
		t.Error("salt not random")
	}
	for _, bad := range []string{"", "x", "pbkdf2-sha256$0$AA$AA", "md5$1$AA$AA", "pbkdf2-sha256$1$!!$AA"} {
		if verifyPassword(bad, "s3cret-pass") {
			t.Errorf("malformed hash %q accepted", bad)
		}
	}
	if verifyPassword(h, strings.Repeat("a", maxPasswordLen+1)) {
		t.Error("over-long password accepted")
	}
}

func TestUserStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "users.json")
	s, err := loadUsers(path)
	if err != nil {
		t.Fatalf("load missing file: %v", err)
	}
	if s.count() != 0 {
		t.Fatalf("count = %d", s.count())
	}
	if err := s.add("admin", "password1", true); err != nil {
		t.Fatal(err)
	}
	if err := s.add("bob", "password2", false); err != nil {
		t.Fatal(err)
	}
	if err := s.add("bob", "x", false); err != errUserExists {
		t.Errorf("duplicate add: %v", err)
	}
	if err := s.add("bad name", "x", false); err != errInvalidName {
		t.Errorf("invalid name: %v", err)
	}
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Errorf("perm = %o, want 600", perm)
		}
	}
	s2, err := loadUsers(path)
	if err != nil {
		t.Fatal(err)
	}
	if s2.count() != 2 || s2.adminCount() != 1 {
		t.Fatalf("count=%d admins=%d", s2.count(), s2.adminCount())
	}
	u, ok := s2.find("bob")
	if !ok || u.Admin || !verifyPassword(u.PasswordHash, "password2") || u.CreatedAt.IsZero() {
		t.Fatalf("bob = %+v", u)
	}
	if l := s2.list(); len(l) != 2 || l[0].Name != "admin" || l[1].Name != "bob" {
		t.Errorf("list order: %+v", l)
	}
	if err := s2.remove("admin"); err != errLastAdmin {
		t.Errorf("remove last admin: %v", err)
	}
	if err := s2.setAdmin("admin", false); err != errLastAdmin {
		t.Errorf("demote last admin: %v", err)
	}
	if err := s2.setPassword("bob", "newpass1"); err != nil {
		t.Fatal(err)
	}
	if err := s2.setAdmin("bob", true); err != nil {
		t.Fatal(err)
	}
	if err := s2.setAdmin("admin", false); err != nil {
		t.Errorf("demote non-last admin: %v", err)
	}
	if err := s2.remove("admin"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s2.find("admin"); ok {
		t.Error("admin still present")
	}
	if u, _ := s2.find("bob"); !verifyPassword(u.PasswordHash, "newpass1") {
		t.Error("setPassword not applied")
	}
	// 目录里不应残留临时文件
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("unexpected files in dir: %d", len(entries))
	}
}

func TestSetupAdminOnce(t *testing.T) {
	s, _ := loadUsers(filepath.Join(t.TempDir(), "users.json"))
	if err := s.setupAdmin("admin", "password1"); err != nil {
		t.Fatal(err)
	}
	if err := s.setupAdmin("other", "password1"); err != errAlreadySetup {
		t.Errorf("second setup: %v", err)
	}
}

func TestLoadUsersErrors(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"corrupt":  "{not json",
		"version2": `{"version":2,"users":[]}`,
		"version0": `{"users":[]}`,
	} {
		p := filepath.Join(dir, name+".json")
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadUsers(p); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestValidUsername(t *testing.T) {
	cases := map[string]bool{
		"admin":                 true,
		"Bob_1.x-y":             true,
		"a":                     true,
		strings.Repeat("a", 32): true,
		"":                      false,
		strings.Repeat("a", 33): false,
		"with space":            false,
		"中文":                    false,
		"a/b":                   false,
		"a@b":                   false,
		"tab\t":                 false,
	}
	for in, want := range cases {
		if got := validUsername(in); got != want {
			t.Errorf("validUsername(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestCheckSameOrigin(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		headers map[string]string
		want    bool
	}{
		{"no headers", "example.com", nil, true},
		{"sfs same-origin", "example.com", map[string]string{"Sec-Fetch-Site": "same-origin"}, true},
		{"sfs none", "example.com", map[string]string{"Sec-Fetch-Site": "none"}, true},
		{"sfs cross-site", "example.com", map[string]string{"Sec-Fetch-Site": "cross-site"}, false},
		{"sfs same-site", "example.com", map[string]string{"Sec-Fetch-Site": "same-site"}, false},
		{"sfs wins over origin", "example.com", map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "http://example.com"}, false},
		{"origin match", "example.com:8080", map[string]string{"Origin": "http://example.com:8080"}, true},
		{"origin match https", "example.com", map[string]string{"Origin": "https://example.com"}, true},
		{"origin other host", "example.com", map[string]string{"Origin": "http://evil.example"}, false},
		{"origin other port", "example.com:8080", map[string]string{"Origin": "http://example.com:9090"}, false},
		{"origin null", "example.com", map[string]string{"Origin": "null"}, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "http://"+c.host+"/login", nil)
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		if got := checkSameOrigin(r); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSiteBase(t *testing.T) {
	for in, want := range map[string]string{"/": "/", "": "/", "/jv": "/jv/", "/a/b": "/a/b/"} {
		if got := siteBase(in); got != want {
			t.Errorf("siteBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSessionRevoke(t *testing.T) {
	s := newSessionStore()
	a1, a2 := s.create("alice"), s.create("alice")
	b := s.create("bob")
	s.revokeUserExcept("alice", a1)
	if _, _, ok := s.get(a1); !ok {
		t.Error("kept session revoked")
	}
	if _, _, ok := s.get(a2); ok {
		t.Error("other session not revoked")
	}
	s.revokeUser("alice")
	if _, _, ok := s.get(a1); ok {
		t.Error("revokeUser failed")
	}
	if u, _, ok := s.get(b); !ok || u != "bob" {
		t.Error("unrelated session affected")
	}
}

func TestLoginLimiter(t *testing.T) {
	l := newLoginLimiter()
	for i := 0; i < loginMaxFails-1; i++ {
		l.fail("ip:x", "user:y")
	}
	if l.blocked("ip:x") {
		t.Fatal("blocked too early")
	}
	l.fail("ip:x", "user:y")
	if !l.blocked("ip:x") || !l.blocked("user:y") {
		t.Fatal("not blocked after max fails")
	}
	l.reset("ip:x", "user:y")
	if l.blocked("ip:x", "user:y") {
		t.Fatal("still blocked after reset")
	}
}

func TestUserStoreReloadIfChanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	a, _ := loadUsers(path)
	if err := a.setupAdmin("admin", "password1"); err != nil {
		t.Fatal(err)
	}
	// 自己保存后不应被当作外部修改
	a.reloadIfChanged()
	if u, _ := a.find("admin"); !verifyPassword(u.PasswordHash, "password1") {
		t.Fatal("own save triggered bad reload")
	}

	// 模拟服务运行中执行 --reset-password：另一个进程读入、改密、写回
	b, err := loadUsers(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.setPassword("admin", "password2"); err != nil {
		t.Fatal(err)
	}
	if err := b.save(); err != nil {
		t.Fatal(err)
	}
	a.reloadIfChanged()
	if u, _ := a.find("admin"); !verifyPassword(u.PasswordHash, "password2") {
		t.Fatal("external password change not visible after reload")
	}

	// 之后服务自己的保存不应覆盖外部改动
	if err := a.add("bob", "password3", false); err != nil {
		t.Fatal(err)
	}
	if err := a.save(); err != nil {
		t.Fatal(err)
	}
	c, err := loadUsers(path)
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := c.find("admin"); !verifyPassword(u.PasswordHash, "password2") {
		t.Error("external change overwritten by later save")
	}
	if _, ok := c.find("bob"); !ok {
		t.Error("bob not saved")
	}

	// 直接改写文件内容（非 Rename）同样能被发现
	data := []byte(`{"version":1,"users":[{"name":"carol","password_hash":"x","admin":true}]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	a.reloadIfChanged()
	if _, ok := a.find("carol"); !ok || a.count() != 1 {
		t.Errorf("rewritten file not reloaded: count=%d", a.count())
	}

	// 文件损坏或被删除时保留内存数据
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.reloadIfChanged()
	if os.Remove(path) != nil {
		t.Fatal("remove")
	}
	a.reloadIfChanged()
	if _, ok := a.find("carol"); !ok {
		t.Error("in-memory users lost after corrupt/missing file")
	}
}
