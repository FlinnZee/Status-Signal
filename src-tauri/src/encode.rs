//! Builds the ffmpeg invocation for the v2 conform recipe (DESIGN.md §3).
//!
//! The whole strategy: hand WhatsApp a detail-rich intermediate so its own
//! unavoidable re-encode has clean, oversized pixels to start from. Every knob
//! below exists for a reason documented in DESIGN.md §3.3 — do not "optimize"
//! them toward WhatsApp's tiny target; that regresses to the soft v1 output.

use std::path::Path;

use crate::config::AppConfig;
use crate::probe::SourceInfo;

/// WhatsApp Status splits uploads at 30s; our optional splitter mirrors that.
const SPLIT_SECONDS: f64 = 30.0;

/// Per-job options coming from the Advanced panel.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncodeOptions {
    pub bitrate_kbps: u32,
    pub res_cap: u32,
    /// "source" | "30" | "60"
    pub fps_mode: String,
    pub split: bool,
}

/// A fully-built ffmpeg command plus the output path(s) it will produce.
pub struct BuiltCommand {
    pub args: Vec<String>,
    pub outputs: Vec<String>,
}

/// Construct the ffmpeg argument vector and the expected output path(s).
pub fn build_command(
    cfg: &AppConfig,
    opts: &EncodeOptions,
    info: &SourceInfo,
    input: &str,
) -> Result<BuiltCommand, String> {
    let in_path = Path::new(input);
    let dir = in_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let stem = in_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "could not derive output name from input".to_string())?;

    let split = opts.split && info.duration_sec > SPLIT_SECONDS;

    // --- video filter: auto-orient scale to the short-edge cap, then pin pixfmt.
    // `a` is the aspect ratio. Wider-than-tall (a>1) locks HEIGHT to the cap;
    // otherwise locks WIDTH. `-2` keeps the other dimension proportional and even
    // (H.264 requires even dimensions). lanczos is a sharper scaler than
    // WhatsApp's internal one. (DESIGN.md §3.3)
    let cap = opts.res_cap;
    let mut vf = format!(
        "scale='if(gt(a,1),-2,{cap})':'if(gt(a,1),{cap},-2)':flags=lanczos,format=yuv420p"
    );
    // Framerate: keep source by default (no -r, ever — it drops frames → judder).
    // If the user caps fps, use the fps filter (proper frame selection). Only
    // downconvert when the source actually exceeds the cap.
    if let Some(cap_fps) = fps_cap(&opts.fps_mode) {
        if info.fps > cap_fps + 0.01 {
            vf.push_str(&format!(",fps={cap_fps}"));
        }
    }

    let x264_params = format!(
        "keyint={k}:min-keyint={k}:ref={r}:bframes={b}:aq-mode={aq}:aq-strength={aqs}",
        k = cfg.keyint,
        r = cfg.r#ref,
        b = cfg.bframes,
        aq = cfg.aq_mode,
        aqs = trim_float(cfg.aq_strength),
    );

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input.to_string(),
        "-vf".into(),
        vf,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        cfg.preset.clone(),
        "-profile:v".into(),
        cfg.profile.clone(),
        "-level".into(),
        cfg.level.clone(),
        "-b:v".into(),
        format!("{}k", opts.bitrate_kbps),
        "-maxrate".into(),
        format!("{}k", cfg.maxrate_kbps),
        "-bufsize".into(),
        format!("{}k", cfg.bufsize_kbps),
        "-x264-params".into(),
        x264_params,
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{}k", cfg.audio_bitrate_kbps),
        "-ar".into(),
        cfg.audio_rate.to_string(),
        "-movflags".into(),
        "+faststart".into(),
        // Machine-readable progress on stdout; keep stderr for real errors only.
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    let outputs;
    if split {
        // Segment muxer cuts at keyframes; force keyframes exactly on the 30s
        // grid so segment boundaries land cleanly. Each segment is independently
        // conformed (DESIGN.md §3.4).
        args.extend([
            "-f".into(),
            "segment".into(),
            "-segment_time".into(),
            "30".into(),
            "-reset_timestamps".into(),
            "1".into(),
            "-force_key_frames".into(),
            "expr:gte(t,n_forced*30)".into(),
        ]);
        let pattern = dir.join(format!("{stem}_puresignal_part%03d.mp4"));
        args.push(path_to_string(&pattern)?);

        let count = (info.duration_sec / SPLIT_SECONDS).ceil().max(1.0) as usize;
        outputs = (0..count)
            .map(|i| {
                path_to_string(&dir.join(format!("{stem}_puresignal_part{i:03}.mp4")))
            })
            .collect::<Result<Vec<_>, _>>()?;
    } else {
        let out = dir.join(format!("{stem}_puresignal.mp4"));
        let out_str = path_to_string(&out)?;
        args.push(out_str.clone());
        outputs = vec![out_str];
    }

    Ok(BuiltCommand { args, outputs })
}

fn fps_cap(mode: &str) -> Option<f64> {
    match mode {
        "30" => Some(30.0),
        "60" => Some(60.0),
        _ => None, // "source" or anything unexpected → keep source fps
    }
}

/// "1" instead of "1.0" when whole, so x264 params stay clean.
fn trim_float(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn path_to_string(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "output path is not valid UTF-8".to_string())
}
