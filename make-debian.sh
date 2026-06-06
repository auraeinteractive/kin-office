#!/bin/bash
# Build kin-office_<version>_<arch>.deb into dist/
# Installs browser-only kin-office apps and static editor assets.
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

cp -a "$ROOT/deploy.sh" "$MODULE_DIR/"
cp -a "$ROOT/build-apps.sh" "$MODULE_DIR/"
chmod 755 "$MODULE_DIR/deploy.sh" "$MODULE_DIR/build-apps.sh"

# Copy helper scripts used to vendor Kin Office browser assets.
if [[ -d "$ROOT/scripts" ]]; then
	cp -a "$ROOT/scripts" "$MODULE_DIR/"
	find "$MODULE_DIR/scripts" -type f -name "*.sh" -exec chmod 755 {} +
fi

# Copy repository/ (Kin apps) — runtime only; Euro-Office source snapshots stay in the dev tree.
mkdir -p "$MODULE_DIR/repository"
rsync -a --exclude 'Applications/Office/kinoffice_common/vendor/kin-office/source/' \
	"$ROOT/repository/" "$MODULE_DIR/repository/"

# Copy kinoffice command (built on demand)
if [ ! -x "$ROOT/commands/kinoffice.cmd/kinoffice" ]; then
	"$ROOT/scripts/build-kinoffice-cmd.sh"
fi
mkdir -p "$MODULE_DIR/commands"
install -m 755 "$ROOT/commands/kinoffice.cmd/kinoffice" "$MODULE_DIR/commands/kinoffice"

# Copy Kin Office collaboration service for future opt-in use (not enabled by default).
if [ ! -x "$ROOT/services/kinoffice-collab/kinoffice-collab.service" ]; then
	"$ROOT/scripts/build-kinoffice-collab-service.sh"
fi
mkdir -p "$MODULE_DIR/services"
install -m 755 "$ROOT/services/kinoffice-collab/kinoffice-collab.service" "$MODULE_DIR/services/kinoffice-collab.service"

# Service runtime config consumed by the browser app after postinst copies repository assets.
printf '{"enabled":false,"host":"127.0.0.1","port":19129,"tls":false}\n' \
    > "$MODULE_DIR/repository/Applications/Office/kinoffice_common/collab_config.json"

# Copy specs/ if present
if [[ -d "$ROOT/specs" ]]; then
	cp -a "$ROOT/specs" "$MODULE_DIR/"
fi

# Copy config example
if [[ -f "$ROOT/.env.example" ]]; then
	cp "$ROOT/.env.example" "$MODULE_DIR/config.example"
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
# Install Kin apps into the runtime repository used by deployed Kin.
if [ -d /opt/kin/modules/kin-office/repository/Applications ]; then
    mkdir -p /usr/lib/kin/repository/Applications
    cp -a /opt/kin/modules/kin-office/repository/Applications/. /usr/lib/kin/repository/Applications/
fi
if [ -x /opt/kin/modules/kin-office/commands/kinoffice ]; then
    mkdir -p /usr/lib/kin/commands
    install -m 755 /opt/kin/modules/kin-office/commands/kinoffice /usr/lib/kin/commands/kinoffice
fi
if [ -x /opt/kin/modules/kin-office/services/kinoffice-collab.service ]; then
    mkdir -p /usr/lib/kin/services
    install -m 755 /opt/kin/modules/kin-office/services/kinoffice-collab.service /usr/lib/kin/services/kinoffice-collab.service
fi
if command -v systemctl >/dev/null 2>&1 && [ -f /lib/systemd/system/kin-office-collab.service ]; then
    systemctl daemon-reload || true
fi
echo "kin-office: installed browser apps and kinoffice command; collaboration service is installed but disabled"
POSTINST
chmod 755 "$STAGE/DEBIAN/postinst"

mkdir -p "$STAGE/lib/systemd/system"
cat >"$STAGE/lib/systemd/system/kin-office-collab.service" <<'UNIT'
[Unit]
Description=Kin Office Collaboration Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/lib/kin/services/kinoffice-collab.service --host 127.0.0.1 --port 19129
Restart=on-failure
RestartSec=1
User=kin
Group=kin

[Install]
WantedBy=multi-user.target
UNIT

cat >"$STAGE/DEBIAN/prerm" <<'PRERM'
#!/bin/bash
set -e
if [ "$1" = remove ] || [ "$1" = deconfigure ]; then
    if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now kin-office-collab.service 2>/dev/null || true
    fi
fi
exit 0
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
Depends: kin (>= 2.0)
Recommends: fonts-maven-pro
Description: Kin Office Module - browser-only office editing for Kin OS
 Browser-only Kin Office integration with direct Kin filesystem access.
 Installs to /opt/kin/modules/kin-office/ and copies Kin workspace apps
 into /usr/lib/kin/repository/Applications.
 .
 Includes static browser editor assets and Kin workspace apps for editing
 docx/xlsx/pptx on Home: and other volumes without Docker.
EOF

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/kin-office_${VERSION}_${ARCH}.deb"
fakeroot dpkg-deb --root-owner-group --build "$STAGE" "$OUT"
echo "Built $OUT"
