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

# Version: top entry in debian/changelog (Debian "upstream-version" or "upstream-version-debian-revision").
# Bump that file before each release so apt upgrade sees a newer package (e.g. 1.0.3-1 > 1.0.1).
if [[ -f "$ROOT/debian/changelog" ]]; then
    VERSION="$(head -1 "$ROOT/debian/changelog" | sed -n 's/.*(\([^)]*\)).*/\1/p')"
fi
if [[ -z "${VERSION:-}" ]]; then
    VERSION="0.0.0-1"
fi

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
if [[ -f "$ROOT/docker-compose.direct.yml" ]]; then
	cp -a "$ROOT/docker-compose.direct.yml" "$MODULE_DIR/"
fi
cp -a "$ROOT/deploy.sh" "$MODULE_DIR/"
cp -a "$ROOT/build-apps.sh" "$MODULE_DIR/"
if [[ -f "$ROOT/write-compose-host-overlay.sh" ]]; then
	cp -a "$ROOT/write-compose-host-overlay.sh" "$MODULE_DIR/"
	chmod 755 "$MODULE_DIR/write-compose-host-overlay.sh"
fi
chmod 755 "$MODULE_DIR/deploy.sh" "$MODULE_DIR/build-apps.sh"

# Copy nginx/ directory
cp -a "$ROOT/nginx" "$MODULE_DIR/"

# Copy direct connector used by direct OnlyOffice launchers
if [[ -d "$ROOT/direct-connector" ]]; then
	cp -a "$ROOT/direct-connector" "$MODULE_DIR/"
	rm -rf "$MODULE_DIR/direct-connector/__pycache__"
fi

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

# Copy systemd service file and wrapper
mkdir -p "$STAGE/lib/systemd/system"
cp "$ROOT/kin-office.service" "$STAGE/lib/systemd/system/"
if [[ -f "$ROOT/kin-office-wrapper.sh" ]]; then
    cp "$ROOT/kin-office-wrapper.sh" "$MODULE_DIR/"
    chmod 755 "$MODULE_DIR/kin-office-wrapper.sh"
fi

# Create /opt/kin/modules/ directory in postinst
mkdir -p "$STAGE/DEBIAN"

cat >"$STAGE/DEBIAN/postinst" <<'POSTINST'
#!/bin/bash
set -e

case "$1" in
    configure) ;;
    abort-upgrade|abort-deconfigure|abort-remove) exit 0 ;;
    *) exit 0 ;;
esac

mkdir -p /opt/kin/modules
chown kin:kin /opt/kin/modules 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/deploy.sh 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/build-apps.sh 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/write-compose-host-overlay.sh 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/kin-office-wrapper.sh 2>/dev/null || true
# Install Kin apps into the runtime repository used by deployed Kin.
if [ -d /opt/kin/modules/kin-office/repository/Applications ]; then
    mkdir -p /usr/lib/kin/repository/Applications
    cp -a /opt/kin/modules/kin-office/repository/Applications/. /usr/lib/kin/repository/Applications/
fi
# Copy service file to correct location and reload systemd
if [ -f /lib/systemd/system/kin-office.service ]; then
    cp /lib/systemd/system/kin-office.service /etc/systemd/system/kin-office.service 2>/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable kin-office.service 2>/dev/null || true
    # First install and upgrades: run the unit so kin-office-wrapper + deploy.sh apply nginx/Nextcloud/OIDC.
    # Do not fail apt if Docker is not ready yet (admin can: sudo systemctl start kin-office).
    set +e
    if systemctl is-active --quiet kin-office.service 2>/dev/null; then
        systemctl restart kin-office.service
        rc=$?
    else
        systemctl start kin-office.service
        rc=$?
    fi
    set -e
    if [ "$rc" != 0 ]; then
        echo "kin-office: systemctl returned $rc (often Docker not running). When ready: sudo systemctl start kin-office" >&2
    fi
else
    echo "kin-office: systemd not available; start manually after boot: sudo systemctl start kin-office" >&2
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
Depends: docker.io (>= 20.10) | docker-ce (>= 20.10), kin (>= 2.0)
Recommends: fonts-maven-pro, nginx
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
