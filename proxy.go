package main

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// trustedProxies 是可信反向代理的地址段；只有直连来源命中其中之一时，
// 才采信 X-Forwarded-For / X-Real-IP 中的客户端地址。
type trustedProxies []netip.Prefix

// splitList 把逗号分隔的列表拆开，去掉空白与空元素。
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseTrustedProxies 解析单个 IP 或 CIDR 组成的列表。
func parseTrustedProxies(list []string) (trustedProxies, error) {
	var out trustedProxies
	for _, s := range list {
		if strings.Contains(s, "/") {
			p, err := netip.ParsePrefix(s)
			if err != nil {
				return nil, fmt.Errorf("trusted_proxies: 无效的 CIDR %q", s)
			}
			if p.Addr().Is4In6() {
				// ::ffff:a.b.c.d/n 写法统一为 IPv4 段，与 Unmap 后的地址比较。
				if bits := p.Bits() - 96; bits >= 0 {
					p = netip.PrefixFrom(p.Addr().Unmap(), bits)
				}
			}
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, fmt.Errorf("trusted_proxies: 无效的 IP %q", s)
		}
		a = a.Unmap().WithZone("")
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

// parseIP 解析单个地址，允许带端口（1.2.3.4:5678、[::1]:80）；统一去掉 IPv4 映射与 zone。
func parseIP(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	a, err := netip.ParseAddr(s)
	if err != nil {
		host, _, err2 := net.SplitHostPort(s)
		if err2 != nil {
			return netip.Addr{}, false
		}
		if a, err = netip.ParseAddr(host); err != nil {
			return netip.Addr{}, false
		}
	}
	return a.Unmap().WithZone(""), true
}

func (t trustedProxies) contains(a netip.Addr) bool {
	for _, p := range t {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// remoteHost 返回直连来源（RemoteAddr）的主机部分。
func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// clientIP 返回用于限速与日志的客户端地址。
// 直连来源不在可信列表内时直接用 RemoteAddr；否则取 X-Forwarded-For 从右往左
// 第一个不可信的地址（全部可信则取最左），没有 X-Forwarded-For 时用 X-Real-IP。
// 结果无法解析为 IP 时回退到 RemoteAddr。
func (t trustedProxies) clientIP(r *http.Request) string {
	fallback := remoteHost(r)
	if len(t) == 0 {
		return fallback
	}
	peer, ok := parseIP(fallback)
	if !ok || !t.contains(peer) {
		return fallback
	}
	if xff := splitList(strings.Join(r.Header.Values("X-Forwarded-For"), ",")); len(xff) > 0 {
		for i := len(xff) - 1; i >= 0; i-- {
			a, ok := parseIP(xff[i])
			if !ok {
				return fallback
			}
			if !t.contains(a) || i == 0 {
				return a.String()
			}
		}
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		if a, ok := parseIP(xr); ok {
			return a.String()
		}
	}
	return fallback
}
