//! Encode preset + the measured WhatsApp target, loaded from a JSON file.
//!
//! Defaults are baked in at compile time from `config/defaults.json` (the single
//! source of truth, DESIGN.md §2/§3). Runtime overrides — including anything the
//! Probe/recalibration flow writes — are persisted to `active.json` in the app
//! config directory, so a recalibration edits exactly one place.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The measured spec of WhatsApp's own Status output (DESIGN.md §2). This is a
/// *reference* the user re-measures over time via Probe mode — it is NOT the
/// intermediate we encode to (that is deliberately much larger, see below).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhatsappTarget {
    pub width: u32,
    pub height: u32,
    pub video_bitrate_kbps: u32,
    pub fps: f64,
    pub profile: String,
    pub level: String,
    pub keyint: u32,
    pub audio_bitrate_kbps: u32,
    pub audio_rate: u32,
}

/// The full active configuration: the v2 encode recipe knobs plus the WhatsApp
/// target reference. Unknown JSON keys (e.g. the `_comment` in defaults.json)
/// are ignored by serde.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    // --- knobs the Advanced panel exposes ---
    pub bitrate_kbps: u32,
    pub res_cap: u32,
    /// "source" | "30" | "60"
    pub fps_mode: String,
    pub split: bool,

    // --- fixed v2-recipe parameters (DESIGN.md §3.2/§3.3) ---
    pub preset: String,
    pub profile: String,
    pub level: String,
    pub maxrate_kbps: u32,
    pub bufsize_kbps: u32,
    pub keyint: u32,
    /// x264 reference frames. `r#ref` because `ref` is a Rust keyword;
    /// `rename` pins the JSON key explicitly.
    #[serde(rename = "ref")]
    pub r#ref: u32,
    pub bframes: u32,
    pub aq_mode: u32,
    pub aq_strength: f64,
    pub audio_bitrate_kbps: u32,
    pub audio_rate: u32,

    // --- recalibration reference ---
    pub whatsapp_target: WhatsappTarget,
}

/// Baked-in defaults — the shipped preset. Parsed once from the embedded JSON.
const DEFAULTS_JSON: &str = include_str!("../../config/defaults.json");

/// Parse the embedded defaults. The file is ours and validated at build time,
/// so a parse failure here is a programming error worth surfacing loudly.
pub fn defaults() -> AppConfig {
    serde_json::from_str(DEFAULTS_JSON).expect("embedded config/defaults.json is invalid")
}

/// Path to the runtime override file in the OS app-config directory.
fn active_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    Ok(dir.join("active.json"))
}

/// Load the active config: overrides if present and valid, else defaults.
pub fn load(app: &AppHandle) -> AppConfig {
    match active_path(app) {
        Ok(path) if path.exists() => match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("active.json invalid ({e}); falling back to defaults");
                defaults()
            }),
            Err(_) => defaults(),
        },
        _ => defaults(),
    }
}

/// Persist the given config as the runtime override.
pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = active_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write active.json: {e}"))
}

/// Remove any override and return the baked-in defaults.
pub fn reset(app: &AppHandle) -> AppConfig {
    if let Ok(path) = active_path(app) {
        let _ = std::fs::remove_file(path); // ignore "not found"
    }
    defaults()
}
