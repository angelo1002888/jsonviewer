//go:build !linux && !darwin

package main

// preserveOwner 在非 linux/darwin 平台上为空实现。
func preserveOwner(newPath, oldPath string) {}
