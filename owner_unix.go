//go:build linux || darwin

package main

import (
	"os"
	"syscall"
)

// preserveOwner：以 root 身份（如 sudo --reset-password）改写用户文件时，
// 让新文件沿用旧文件的 uid/gid，避免以普通用户运行的服务之后无法写入。
func preserveOwner(newPath, oldPath string) {
	if os.Geteuid() != 0 {
		return
	}
	fi, err := os.Stat(oldPath)
	if err != nil {
		return
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	_ = os.Chown(newPath, int(st.Uid), int(st.Gid))
}
