SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/repository/Applications"
BUILD_DIR="$SCRIPT_DIR/build/repository/Applications"
CONFIG_FILE="$SCRIPT_DIR/.config.ini"

KIN_BUILD_PATH=""

load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        KIN_BUILD_PATH=$(grep "^KIN_BUILD_PATH=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)
    fi
}

save_config() {
    if [ -n "$KIN_BUILD_PATH" ]; then
        echo "KIN_BUILD_PATH=$KIN_BUILD_PATH" > "$CONFIG_FILE"
        echo "Saved Kin build path to config: $KIN_BUILD_PATH"
    fi
}

prompt_kin_path() {
    echo ""
    echo "Enter the path to your Kin build directory (e.g. /home/user/Projects/kin/build):"
    echo -n "> "
    read -r KIN_BUILD_PATH
    KIN_BUILD_PATH=$(echo "$KIN_BUILD_PATH" | sed 's:/*$::')
    
    if [ -z "$KIN_BUILD_PATH" ]; then
        echo "No path provided. Skipping install."
        return 1
    fi
    
    if [ ! -d "$KIN_BUILD_PATH" ]; then
        echo "Error: Directory does not exist: $KIN_BUILD_PATH"
        return 1
    fi
    
    return 0
}

install_to_kin() {
    if [ -z "$KIN_BUILD_PATH" ]; then
        return
    fi
    
    # Try repository first (legacy/actual build location), then applications
    KIN_REPO_DIR="$KIN_BUILD_PATH/repository/Applications"
    if [ ! -d "$KIN_REPO_DIR" ]; then
        KIN_REPO_DIR="$KIN_BUILD_PATH/applications"
    fi
    
    if [ ! -d "$KIN_REPO_DIR" ]; then
        echo "Error: Kin repository directory not found at $KIN_BUILD_PATH/repository/Applications or applications"
        return
    fi

    OFFICE_SRC="$SOURCE_DIR/Office"
    OFFICE_DEST="$KIN_REPO_DIR/Office"
    KINOFFICE_APPS="kinoffice_common kinoffice_docs kinoffice_sheets kinoffice_slides"
    if [ ! -d "$OFFICE_SRC" ]; then
        echo "Error: Kin Office apps not found at $OFFICE_SRC"
        return 1
    fi
    
    echo "Source: $OFFICE_SRC"
    echo "Destination: $OFFICE_DEST"
    mkdir -p "$OFFICE_DEST"
    for app in $KINOFFICE_APPS; do
        if [ ! -d "$OFFICE_SRC/$app" ]; then
            echo "Error: missing Kin Office app dir: $OFFICE_SRC/$app"
            return 1
        fi
        rsync -av "$OFFICE_SRC/$app/" "$OFFICE_DEST/$app/"
        echo "Installed $OFFICE_DEST/$app"
    done
    echo "Apps installed to Kin build (kinoffice_* only; other Office apps untouched)."
}

install_kinoffice_cmd() {
    if [ -z "$KIN_BUILD_PATH" ]; then
        return
    fi
    CMD_SRC="$SCRIPT_DIR/commands/kinoffice.cmd/kinoffice"
    if [ ! -x "$CMD_SRC" ]; then
        echo "Building kinoffice command..."
        "$SCRIPT_DIR/scripts/build-kinoffice-cmd.sh"
    fi
    if [ ! -x "$CMD_SRC" ]; then
        echo "Error: kinoffice command not built at $CMD_SRC"
        return 1
    fi
    DEST="$KIN_BUILD_PATH/commands"
    mkdir -p "$DEST"
    install -m 755 "$CMD_SRC" "$DEST/kinoffice"
    echo "Installed $DEST/kinoffice"
}

load_config

echo ""
echo "=== Kin Office Apps Build Script ==="
echo ""

if [ -z "$KIN_BUILD_PATH" ]; then
    if prompt_kin_path; then
        save_config
    fi
else
    echo "Using Kin build path from config: $KIN_BUILD_PATH"
fi

echo ""
echo "=== Building local copy ==="
mkdir -p "$BUILD_DIR"

if [ -d "$SOURCE_DIR" ]; then
    echo "Source: $SOURCE_DIR"
    echo "Destination: $BUILD_DIR"
    echo "Copying files..."
    rsync -av --delete "$SOURCE_DIR/" "$BUILD_DIR/"
    echo "Done. Apps built to $BUILD_DIR"
else
    echo "Error: No repository directory found at $SOURCE_DIR"
    exit 1
fi

echo ""
echo "=== Installing to Kin build ==="

if [ -n "$KIN_BUILD_PATH" ]; then
    install_to_kin
    install_kinoffice_cmd
else
    echo "KIN_BUILD_PATH not set, skipping Kin install"
fi

echo ""
echo "=== Build complete ==="
