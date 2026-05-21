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
    
    echo "Source: $SOURCE_DIR"
    echo "Destination: $KIN_REPO_DIR"
    echo "Files in source:"
    ls -laR "$SOURCE_DIR/"
    echo "Checking destination:"
    ls -la "$KIN_REPO_DIR/Internet/"
    ls -la "$KIN_REPO_DIR/Office/"
    echo "Copying files with verbose rsync..."
    rsync -av "$SOURCE_DIR/" "$KIN_REPO_DIR/"
    echo "Apps installed to Kin build."
    # `kinonlyoffice_*` are real package ids in this tree. The Kin repo workspace must not
    # rewrite them to `remote_onlyoffice` in clients/workspace/scripts/base.js:normalizeRepoPackageId
    # or the app menu will open the wrong package after rsync.
}

load_config

echo ""
echo "=== Kin OnlyOffice Apps Build Script ==="
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
else
    echo "KIN_BUILD_PATH not set, skipping Kin install"
fi

echo ""
echo "=== Build complete ==="
