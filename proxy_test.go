package main

import (
	"net/http/httptest"
	"testing"
)

func TestClientIP(t *testing.T) {
	cases := []struct {
		name    string
		trusted string
		remote  string
		xff     []string
		realIP  string
		want    string
	}{
		{"未配置时忽略 XFF", "", "127.0.0.1:5000", []string{"203.0.113.9"}, "198.51.100.1", "127.0.0.1"},
		{"直连来源不可信时忽略 XFF", "127.0.0.1", "192.0.2.7:5000", []string{"203.0.113.9"}, "", "192.0.2.7"},
		{"可信代理取 XFF", "127.0.0.1", "127.0.0.1:5000", []string{"203.0.113.9"}, "", "203.0.113.9"},
		{"IPv6 可信代理", "::1", "[::1]:5000", []string{"2001:db8::9"}, "", "2001:db8::9"},
		{"IPv4 映射地址", "127.0.0.1", "[::ffff:127.0.0.1]:5000", []string{"203.0.113.9"}, "", "203.0.113.9"},
		{"CIDR 匹配", "10.0.0.0/8", "10.1.2.3:5000", []string{"203.0.113.9"}, "", "203.0.113.9"},
		{"CIDR 不匹配", "10.0.0.0/8", "11.1.2.3:5000", []string{"203.0.113.9"}, "", "11.1.2.3"},
		{"伪造多级 XFF 取最右非可信", "127.0.0.1, 10.0.0.0/8", "127.0.0.1:5000", []string{"1.1.1.1, 203.0.113.9, 10.0.0.5"}, "", "203.0.113.9"},
		{"多个 XFF 头合并", "127.0.0.1, 10.0.0.0/8", "127.0.0.1:5000", []string{"1.1.1.1", "203.0.113.9, 10.0.0.5"}, "", "203.0.113.9"},
		{"全部可信取最左", "127.0.0.1, 10.0.0.0/8", "127.0.0.1:5000", []string{"10.0.0.1, 10.0.0.2"}, "", "10.0.0.1"},
		{"XFF 带端口", "127.0.0.1", "127.0.0.1:5000", []string{"203.0.113.9:4444"}, "", "203.0.113.9"},
		{"无 XFF 用 X-Real-IP", "127.0.0.1", "127.0.0.1:5000", nil, "198.51.100.1", "198.51.100.1"},
		{"XFF 优先于 X-Real-IP", "127.0.0.1", "127.0.0.1:5000", []string{"203.0.113.9"}, "198.51.100.1", "203.0.113.9"},
		{"XFF 非法值回退", "127.0.0.1", "127.0.0.1:5000", []string{"1.1.1.1, not-an-ip"}, "", "127.0.0.1"},
		{"X-Real-IP 非法值回退", "127.0.0.1", "127.0.0.1:5000", nil, "unknown", "127.0.0.1"},
		{"无任何头回退", "127.0.0.1", "127.0.0.1:5000", nil, "", "127.0.0.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var cfg Config
			if err := applyOption(&cfg, "trusted_proxies", c.trusted); err != nil {
				t.Fatal(err)
			}
			tp, err := parseTrustedProxies(cfg.TrustedProxies)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = c.remote
			for _, v := range c.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if c.realIP != "" {
				r.Header.Set("X-Real-IP", c.realIP)
			}
			if got := tp.clientIP(r); got != c.want {
				t.Errorf("clientIP = %q, want %q", got, c.want)
			}
		})
	}
}

func TestTrustedProxiesOption(t *testing.T) {
	var cfg Config
	if err := applyOption(&cfg, "trusted_proxies", " 127.0.0.1, ::1 ,10.0.0.0/8,"); err != nil {
		t.Fatal(err)
	}
	if len(cfg.TrustedProxies) != 3 {
		t.Fatalf("TrustedProxies = %q", cfg.TrustedProxies)
	}
	if err := applyOption(&cfg, "trusted_proxies", ""); err != nil || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("空值应清空列表: %v %q", err, cfg.TrustedProxies)
	}
	for _, bad := range []string{"300.1.1.1", "10.0.0.0/99", "example.com", "127.0.0.1, x"} {
		if err := applyOption(&cfg, "trusted_proxies", bad); err == nil {
			t.Errorf("%q 应报错", bad)
		}
	}
}
