//! Path resolvers for Claude CLI configuration files.
use std::path::PathBuf;

pub fn get_claude_config_dir() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .unwrap_or_else(|| PathBuf::from(".claude"))
}

pub fn get_claude_settings_path() -> PathBuf {
    let dir = get_claude_config_dir();
    let settings = dir.join("settings.json");
    if settings.exists() {
        return settings;
    }
    let legacy = dir.join("claude.json");
    if legacy.exists() {
        return legacy;
    }
    settings
}
