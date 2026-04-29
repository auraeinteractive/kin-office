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

# Version: read from debian/changelog and increment build number
if [[ -f "$ROOT/debian/changelog" ]]; then
    CURRENT="$(head -1 "$ROOT/debian/changelog" | sed -n 's/.*(\([^)]*\)).*/\1/p')"
    # Remove debian revision (e.g., 1.0.0-1 -> 1.0.0)
    BASE="${CURRENT%-*}"
    # Extract major.minor and build number (e.g., 1.0.0 -> major.minor=1.0, build=0)
    if [[ "$BASE" =~ ^([0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
        MAJOR_MINOR="${BASH_REMATCH[1]}"
        BUILD="${BASH_REMATCH[2]}"
        BUILD=$((BUILD + 1))
        VERSION="${MAJOR_MINOR}.${BUILD}"
    else
        VERSION="1.0.1"
    fi
else
    VERSION="1.0.1"
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
mkdir -p /opt/kin/modules
chown kin:kin /opt/kin/modules 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/deploy.sh 2>/dev/null || true
chmod 755 /opt/kin/modules/kin-office/build-apps.sh 2>/dev/null || true
# Install Kin apps into the runtime repository used by deployed Kin.
if [ -d /opt/kin/modules/kin-office/repository/Applications ]; then
    mkdir -p /usr/lib/kin/repository/Applications
    cp -a /opt/kin/modules/kin-office/repository/Applications/. /usr/lib/kin/repository/Applications/
fi
# Copy service file to correct location and reload systemd
if [ -f /lib/systemd/system/kin-office.service ]; then
    cp /lib/systemd/system/kin-office.service /etc/systemd/system/kin-office.service 2>/dev/null || true
fi
systemctl daemon-reload 2>/dev/null || true
systemctl enable kin-office.service 2>/dev/null || true
# Do NOT run deploy or start service here - wrapper handles it on service start
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
