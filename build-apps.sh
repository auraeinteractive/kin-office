SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/repository"
BUILD_DIR="$SCRIPT_DIR/build/repository"
CONFIG_FILE="$SCRIPT_DIR/.config.ini"

KIN_BUILD_PATH=""

load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        KIN_BUILD_PATH=$(grep "^KIN_BUILD_PATH=" "$CONFIG_FILE" 2>/dev/null | cut -d'=' -f2-)
    fi
}

save_config() {
    if [ -n "$KIN_BUILD_PATH" ]; then
        echo "KIN_BUILD_PATH=$KIN_BUILD_PATH" > "$CONFIG_FILE"
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
    
    KIN_REPO_DIR="$KIN_BUILD_PATH/repository"
    
    if [ ! -d "$KIN_REPO_DIR" ]; then
        echo "Error: Kin repository directory not found at $KIN_REPO_DIR"
        return
    fi
    
    echo "Installing apps to $KIN_REPO_DIR..."
    rsync -a "$SOURCE_DIR/" "$KIN_REPO_DIR/"
    echo "Apps installed to Kin build."
}

load_config

if [ -z "$KIN_BUILD_PATH" ]; then
    if prompt_kin_path; then
        save_config
    fi
else
    echo "Using Kin build path from config: $KIN_BUILD_PATH"
fi

echo "Building Kin Nextcloud apps..."
mkdir -p "$BUILD_DIR"

if [ -d "$SOURCE_DIR" ]; then
    rsync -a "$SOURCE_DIR/" "$BUILD_DIR/"
    echo "Done. Apps built to $BUILD_DIR"
else
    echo "No repository directory found at $SOURCE_DIR"
    exit 1
fi

if [ -n "$KIN_BUILD_PATH" ] && [ -d "$KIN_BUILD_PATH" ]; then
    install_to_kin
fi

echo "Build complete."
