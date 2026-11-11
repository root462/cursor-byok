//! Path resolvers for Codex Desktop configuration and catalog files.
use std::path::PathBuf;

pub fn get_codex_config_dir() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|cwd| cwd.join(".codex"))
                .unwrap_or_else(|_| PathBuf::from(".codex"))
        })
}

pub fn get_codex_config_path() -> PathBuf {
    get_codex_config_dir().join("config.toml")
}

pub fn get_codex_catalog_path() -> PathBuf {
    get_codex_config_dir().join("cursor-byok-model-catalog.json")
}
