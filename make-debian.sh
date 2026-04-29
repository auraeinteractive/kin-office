#!/bin/bash
# Build kin-office_<version>_<arch>.deb into dist/
# Installs to /opt/kin/modules/kin-office/ with deploy.sh in PATH
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! command -v fakeroot >/dev/null 2>&1; then
	echo "install fakeroot: sudo apt install fakeroot" >&2
	exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
	echo "install dpkg-deb (dpkg package)" >&2
	exit 1
fi

# Version from git or default
VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo "1.0.0")"
VERSION="${VERSION#v}"

if command -v dpkg-architecture >/dev/null 2>&1; then
	ARCH="$(dpkg-architecture -qDEB_HOST_ARCH)"
else
	ARCH="$(uname -m)"
	case "$ARCH" in
	x86_64) ARCH=amd64 ;;
	aarch64) ARCH=arm64 ;;
	esac
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kin-office-deb.XXXXXX")"
cleanup() {
	rm -rf "$STAGE"
}
trap cleanup EXIT

# Install layout: /opt/kin/modules/kin-office/
MODULE_DIR="$STAGE/opt/kin/modules/kin-office"
mkdir -p "$MODULE_DIR"

# Copy all needed files
cp -a "$ROOT/docker-compose.yml" "$MODULE_DIR/"
cp -a "$ROOT/deploy.sh" "$MODULE_DIR/"
cp -a "$ROOT/build-apps.sh" "$MODULE_DIR/"
chmod 755 "$MODULE_DIR/deploy.sh" "$MODULE_DIR/build-apps.sh"

# Copy nginx/ directory
cp -a "$ROOT/nginx" "$MODULE_DIR/"

# Copy repository/ (Kin apps)
cp -a "$ROOT/repository" "$MODULE_DIR/"

# Copy specs/ if present
if [[ -d "$ROOT/specs" ]]; then
	cp -a "$ROOT/specs" "$MODULE_DIR/"
fi

# Copy config example
if [[ -f "$ROOT/.env.example" ]]; then
	cp "$ROOT/.env.example" "$MODULE_DIR/config.example"
fi

# Copy systemd service file
if [[ -f "$ROOT/kin-office.service" ]]; then
	mkdir -p "$STAGE/etc/systemd/system"
	cp "$ROOT/kin-office.service" "$STAGE/etc/systemd/system/"
fi

# Create /opt/kin/modules/ directory in postinst
mkdir -p "$STAGE/DEBIAN"

cat >"$STAGE/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e
mkdir -p /opt/kin/modules
chown kin:kin /opt/kin/modules 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/deploy.sh 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/build-apps.sh 2>/dev/null || true
# Reload systemd and enable service
if [ -f /etc/systemd/system/kin-office.service ]; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable kin-office.service 2>/dev/null || true
fi
POSTINST
chmod 755 "$STAGE/DEBIAN/postinst"

cat >"$STAGE/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
# Stop and disable service before removal
if [ -f /etc/systemd/system/kin-office.service ]; then
    systemctl stop kin-office.service 2>/dev/null || true
    systemctl disable kin-office.service 2>/dev/null || true
fi
PRERM
chmod 755 "$STAGE/DEBIAN/prerm"

# Control file
SIZE="$(du -sk "$MODULE_DIR" 2>/dev/null | cut -f1)"
SIZE="${SIZE:-0}"

cat >"$STAGE/DEBIAN/control" <<EOF
Package: kin-office
Version: $VERSION
Section: misc
Priority: optional
Architecture: $ARCH
Maintainer: Kin <packages@os-kin.com>
Installed-Size: $SIZE
Depends: docker.io | docker-ce, kin (>= 2.0)
Recommends: fonts-maven-pro, nginx
Recommends: fonts-maven-pro
Description: Kin Office Module - Nextcloud with OnlyOffice integration
 Nextcloud with OnlyOffice DocumentServer integration for Kin OS.
 Installs to /opt/kin/modules/kin-office/ and integrates with Kin's
 nginx reverse proxy for same-origin iframe embedding.
 .
 Includes docker-compose setup, kin-bridge.js for postMessage API,
 and Kin workspace apps for OnlyOffice file editing.
EOF

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/kin-office_${VERSION}_${ARCH}.deb"
fakeroot dpkg-deb --root-owner-group --build "$STAGE" "$OUT"
echo "Built $OUT"
