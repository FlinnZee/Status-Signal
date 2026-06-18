//! Tauri command surface — the JS<->Rust contract (mirrors src/lib/api.js).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config::{self, AppConfig, WhatsappTarget};
use crate::encode::{self, EncodeOptions};
use crate::ffmpeg;
use crate::probe::{self, SourceInfo};

/// Inspect a source file (resolution, fps, codec, bitrate, duration, …).
#[tauri::command]
pub async fn probe_file(app: AppHandle, path: String) -> Result<SourceInfo, String> {
    probe::probe_source(&app, &path).await
}

/// A queued encode job from the frontend.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeJob {
    pub job_id: String,
    pub input: String,
    pub options: EncodeOptions,
}

/// What an encode produced.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeResult {
    pub outputs: Vec<String>,
    /// Always 0 with the v2 recipe — we never frame-drop (DESIGN.md §3.1). Kept
    /// as an explicit acceptance signal (§7.1).
    pub dropped_frames: i64,
}

/// Conform one file with the v2 recipe. Progress streams on `encode://progress`;
/// this resolves with the output path(s) once ffmpeg finishes.
#[tauri::command]
pub async fn encode_file(app: AppHandle, job: EncodeJob) -> Result<EncodeResult, String> {
    let cfg = config::load(&app);

    // Probe first: the duration drives the progress percentage, and the
    // dimensions/fps inform the filter chain.
    let info = probe::probe_source(&app, &job.input).await?;
    let built = encode::build_command(&cfg, &job.options, &info, &job.input)?;

    let duration_us = info.duration_sec * 1_000_000.0;
    ffmpeg::run_encode(&app, built.args, duration_us, &job.job_id).await?;

    // Keep only outputs that actually materialized (segment count is an upper
    // bound; the final partial segment may or may not exist depending on length).
    let outputs: Vec<String> = built
        .outputs
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .collect();
    if outputs.is_empty() {
        return Err("encode finished but produced no output file".into());
    }

    Ok(EncodeResult {
        outputs,
        dropped_frames: 0,
    })
}

/// One row of the recalibration diff (stored preset vs freshly measured target).
#[derive(Serialize)]
pub struct DiffRow {
    pub label: String,
    pub current: String,
    pub measured: String,
    pub changed: bool,
}

/// Result of probing a WhatsApp-processed clip: the measured target (ready to
/// merge into config) plus a human-readable diff.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// `{ "whatsappTarget": { … } }` — shape the frontend merges into the config.
    pub target: serde_json::Value,
    pub diff: Vec<DiffRow>,
}

/// Measure a WhatsApp-processed clip and diff it against the stored target
/// (DESIGN.md §6). This updates the *reference* of what WhatsApp currently does;
/// it does not touch the (deliberately larger) intermediate encode knobs.
#[tauri::command]
pub async fn probe_recalibrate(app: AppHandle, path: String) -> Result<ProbeReport, String> {
    let cfg = config::load(&app);
    let info = probe::probe_source(&app, &path).await?;
    let keyint = probe::probe_keyint(&app, &path)
        .await
        .unwrap_or(cfg.whatsapp_target.keyint);

    let measured = WhatsappTarget {
        width: info.width,
        height: info.height,
        video_bitrate_kbps: info.bitrate_kbps.round() as u32,
        fps: round2(info.fps),
        profile: simplify_profile(&info.profile),
        level: info.level.clone(),
        keyint,
        audio_bitrate_kbps: info.audio_bitrate_kbps.map(|b| b.round() as u32).unwrap_or(0),
        audio_rate: info.audio_rate.unwrap_or(0),
    };

    let cur = &cfg.whatsapp_target;
    let diff = vec![
        diff_row(
            "Resolution",
            format!("{}x{}", cur.width, cur.height),
            format!("{}x{}", measured.width, measured.height),
        ),
        diff_row(
            "Video bitrate",
            format!("{} kbps", cur.video_bitrate_kbps),
            format!("{} kbps", measured.video_bitrate_kbps),
        ),
        diff_row(
            "Framerate",
            format!("{} fps", trim(cur.fps)),
            format!("{} fps", trim(measured.fps)),
        ),
        diff_row("Profile", cur.profile.clone(), measured.profile.clone()),
        diff_row(
            "GOP / keyint",
            cur.keyint.to_string(),
            measured.keyint.to_string(),
        ),
        diff_row(
            "Audio bitrate",
            format!("{} kbps", cur.audio_bitrate_kbps),
            format!("{} kbps", measured.audio_bitrate_kbps),
        ),
        diff_row(
            "Audio rate",
            format!("{} Hz", cur.audio_rate),
            format!("{} Hz", measured.audio_rate),
        ),
    ];

    let target = serde_json::json!({ "whatsappTarget": measured });
    Ok(ProbeReport { target, diff })
}

/// Active config (defaults overlaid with any saved overrides).
#[tauri::command]
pub fn get_config(app: AppHandle) -> AppConfig {
    config::load(&app)
}

/// Persist config overrides; echoes back the saved config.
#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    config::save(&app, &config)?;
    Ok(config)
}

/// Restore the baked-in defaults.
#[tauri::command]
pub fn reset_config(app: AppHandle) -> AppConfig {
    config::reset(&app)
}

// --- helpers ---

fn diff_row(label: &str, current: String, measured: String) -> DiffRow {
    let changed = current != measured;
    DiffRow {
        label: label.to_string(),
        current,
        measured,
        changed,
    }
}

/// Collapse ffprobe's verbose profile names to the short token we store.
fn simplify_profile(p: &str) -> String {
    let lower = p.to_lowercase();
    if lower.contains("baseline") {
        "baseline".into()
    } else if lower.contains("high") {
        "high".into()
    } else if lower.contains("main") {
        "main".into()
    } else if lower.is_empty() {
        "unknown".into()
    } else {
        lower
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn trim(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}
