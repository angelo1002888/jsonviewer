#!/usr/bin/env bash
# jsonviewer 一键安装脚本：从 GitHub Release 下载二进制、配置模板与 systemd 单元。
# 只安装文件，不启动服务；完成后打印启动命令。
#
# 用法（安装最新 Release，监听 :8080，不启动服务）：
#   curl -fsSL https://raw.githubusercontent.com/angelo1002888/jsonviewer/main/deploy/install.sh | sudo bash
#
# 环境变量：
#   JSONVIEWER_ROOT   安装路径前缀，默认 /；不为 / 时跳过 useradd 与 systemctl（仅用于测试）
set -euo pipefail

REPO="angelo1002888/jsonviewer"
VERSION=""
ROOT="${JSONVIEWER_ROOT:-/}"
ROOT="${ROOT%/}"   # "/" -> ""，"/tmp/x/" -> "/tmp/x"

say() { printf '==> %s\n' "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

# ---- 前置检查 ----
[ "$(uname -s)" = "Linux" ] || die "仅支持 Linux"

case "$(uname -m)" in
	x86_64|amd64) ARCH=amd64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) die "不支持的架构: $(uname -m)（仅支持 x86_64 / aarch64）" ;;
esac

if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
	die "需要 root 权限，请用 sudo 运行（例如: curl -fsSL ... | sudo bash）"
fi

if command -v curl >/dev/null 2>&1; then
	DL=curl
elif command -v wget >/dev/null 2>&1; then
	DL=wget
else
	die "需要 curl 或 wget"
fi
command -v sha256sum >/dev/null 2>&1 || die "需要 sha256sum（coreutils）"

# download <url> <输出文件>
download() {
	if [ "$DL" = curl ]; then
		curl -fsSL --retry 3 -o "$2" "$1"
	else
		wget -q -O "$2" "$1"
	fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- 确定版本 ----
if [ -z "$VERSION" ]; then
	say "查询最新版本"
	download "https://api.github.com/repos/$REPO/releases/latest" "$TMP/latest.json" \
		|| die "无法访问 GitHub API 获取最新版本"
	VERSION="$(grep -m1 '"tag_name"' "$TMP/latest.json" \
		| sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')" || true
	[ -n "$VERSION" ] || die "无法解析最新版本号"
fi
say "安装版本 $VERSION（架构 $ARCH）"

# ---- 下载 ----
BIN="jsonviewer-linux-$ARCH"
BASE="https://github.com/$REPO/releases/download/$VERSION"
for f in "$BIN" SHA256SUMS jsonviewer.service jsonviewer.conf; do
	say "下载 $f"
	download "$BASE/$f" "$TMP/$f" || die "下载失败: $BASE/$f"
done

say "校验 SHA256"
grep -q "[[:space:]]\*\{0,1\}$BIN\$" "$TMP/SHA256SUMS" || die "SHA256SUMS 中没有 $BIN"
(cd "$TMP" && sha256sum -c --ignore-missing --quiet SHA256SUMS) || die "校验失败"

# ---- 安装 ----
BIN_DST="$ROOT/usr/local/bin/jsonviewer"
CONF_DIR="$ROOT/etc/jsonviewer"
CONF_DST="$CONF_DIR/jsonviewer.conf"
UNIT_DST="$ROOT/etc/systemd/system/jsonviewer.service"

say "安装二进制 -> $BIN_DST"
install -d -m 0755 "$(dirname "$BIN_DST")"
install -m 0755 "$TMP/$BIN" "$BIN_DST"

if [ -z "$ROOT" ]; then
	if id jsonviewer >/dev/null 2>&1; then
		say "系统用户 jsonviewer 已存在"
	else
		say "创建系统用户 jsonviewer"
		useradd -r -s /usr/sbin/nologin -d /nonexistent jsonviewer
	fi
else
	say "JSONVIEWER_ROOT=$ROOT，跳过创建用户"
fi

install -d -m 0755 "$CONF_DIR"
if [ -z "$ROOT" ]; then
	# 启用登录验证时服务需要在该目录写入 users.json；配置文件本身仍为 root 0644
	chown jsonviewer:jsonviewer "$CONF_DIR"
	chmod 0750 "$CONF_DIR"
fi
CONF_NEW=""
if [ -e "$CONF_DST" ]; then
	CONF_NEW="$CONF_DST.new"
	say "配置文件已存在，保留原文件；新模板写入 $CONF_NEW"
	install -m 0644 "$TMP/jsonviewer.conf" "$CONF_NEW"
else
	say "写入配置 -> $CONF_DST"
	install -m 0644 "$TMP/jsonviewer.conf" "$CONF_DST"
fi

say "安装 systemd 单元 -> $UNIT_DST"
install -d -m 0755 "$(dirname "$UNIT_DST")"
install -m 0644 "$TMP/jsonviewer.service" "$UNIT_DST"

if [ -z "$ROOT" ]; then
	if command -v systemctl >/dev/null 2>&1; then
		say "systemctl daemon-reload"
		systemctl daemon-reload || printf '警告: systemctl daemon-reload 失败\n' >&2
	else
		say "未找到 systemctl，跳过 daemon-reload"
	fi
else
	say "JSONVIEWER_ROOT=$ROOT，跳过 systemctl"
fi

# ---- 汇总 ----
cat <<DONE

安装完成（版本 $VERSION，架构 $ARCH）
  二进制: $BIN_DST
  配置:   $CONF_DST
  服务:   $UNIT_DST
DONE
if [ -n "$CONF_NEW" ]; then
	cat <<DONE
  注意:   配置文件已存在未覆盖，新版模板在 $CONF_NEW ，请自行比对合并
DONE
fi
cat <<'DONE'

启动服务（未自动执行）：
  sudo systemctl enable --now jsonviewer
查看状态与日志：
  sudo systemctl status jsonviewer
  sudo journalctl -u jsonviewer -f
启用登录验证：编辑 /etc/jsonviewer/jsonviewer.conf 设置 auth = true 并重启，首次访问网页设置管理员
DONE
