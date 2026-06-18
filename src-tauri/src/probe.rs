//! ffprobe-based source inspection and WhatsApp-target measurement.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::ffmpeg;

/// Everything we surface about a source clip (shown in the queue, used to drive
/// the encode, and reused for recalibration).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub profile: String,
    /// e.g. "4.2" (ffprobe reports the integer 42).
    pub level: String,
    pub bitrate_kbps: f64,
    pub duration_sec: f64,
    pub has_audio: bool,
    pub audio_bitrate_kbps: Option<f64>,
    pub audio_rate: Option<u32>,
    pub pix_fmt: String,
    pub container: String,
}

/// Run `ffprobe -print_format json` and parse the streams/format we care about.
pub async fn probe_source(app: &AppHandle, path: &str) -> Result<SourceInfo, String> {
    let args = vec![
        "-v".into(),
        "quiet".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string(),
    ];
    let out = ffmpeg::capture(app, ffmpeg::FFPROBE, args).await?;
    if out.code != 0 && out.stdout.trim().is_empty() {
        return Err(format!("ffprobe failed: {}", tail(&out.stderr)));
    }
    let root: Value =
        serde_json::from_str(&out.stdout).map_err(|e| format!("ffprobe JSON parse: {e}"))?;

    let streams = root
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let format = root.get("format").cloned().unwrap_or(Value::Null);

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| "no video stream found".to_string())?;
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));

    let width = video.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let height = video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    let codec = str_field(video, "codec_name");
    let profile = str_field(video, "profile");
    let pix_fmt = str_field(video, "pix_fmt");
    let level = match video.get("level").and_then(Value::as_i64) {
        Some(l) if l > 0 => format!("{:.1}", l as f64 / 10.0),
        _ => String::new(),
    };

    // Prefer avg_frame_rate; fall back to r_frame_rate.
    let fps = parse_rational(&str_field(video, "avg_frame_rate"))
        .filter(|f| *f > 0.0)
        .or_else(|| parse_rational(&str_field(video, "r_frame_rate")))
        .unwrap_or(0.0);

    // Video stream bitrate if present, else overall container bitrate.
    let bitrate_kbps = num_field(video, "bit_rate")
        .or_else(|| num_field(&format, "bit_rate"))
        .map(|b| b / 1000.0)
        .unwrap_or(0.0);

    let duration_sec = num_field(&format, "duration")
        .or_else(|| num_field(video, "duration"))
        .unwrap_or(0.0);

    let (audio_bitrate_kbps, audio_rate) = match audio {
        Some(a) => (
            num_field(a, "bit_rate").map(|b| b / 1000.0),
            str_field(a, "sample_rate").parse::<u32>().ok(),
        ),
        None => (None, None),
    };

    let container = str_field(&format, "format_name")
        .split(',')
        .next()
        .unwrap_or("")
        .to_string();

    Ok(SourceInfo {
        width,
        height,
        fps,
        codec,
        profile,
        level,
        bitrate_kbps,
        duration_sec,
        has_audio: audio.is_some(),
        audio_bitrate_kbps,
        audio_rate,
        pix_fmt,
        container,
    })
}

/// Measure the GOP length (keyframe interval) by reading the key-frame flags of
/// the first ~90 frames and taking the gap between the first two keyframes.
/// Bounded with `-read_intervals` so it stays fast even on long sources.
pub async fn probe_keyint(app: &AppHandle, path: &str) -> Option<u32> {
    let args = vec![
        "-v".into(),
        "quiet".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "frame=key_frame".into(),
        "-of".into(),
        "csv=p=0".into(),
        "-read_intervals".into(),
        "%+#90".into(),
        path.to_string(),
    ];
    let out = ffmpeg::capture(app, ffmpeg::FFPROBE, args).await.ok()?;

    let flags: Vec<bool> = out
        .stdout
        .lines()
        .map(|l| l.trim().starts_with('1'))
        .collect();
    let key_positions: Vec<usize> = flags
        .iter()
        .enumerate()
        .filter(|(_, k)| **k)
        .map(|(i, _)| i)
        .collect();
    if key_positions.len() >= 2 {
        Some((key_positions[1] - key_positions[0]) as u32)
    } else {
        None
    }
}

// --- small JSON helpers ---

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Numbers in ffprobe JSON are usually strings ("630000"); handle both.
fn num_field(v: &Value, key: &str) -> Option<f64> {
    match v.get(key) {
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

/// "60/1" → 60.0, "30000/1001" → 29.97.
fn parse_rational(s: &str) -> Option<f64> {
    let mut it = s.split('/');
    let num: f64 = it.next()?.parse().ok()?;
    let den: f64 = it.next().unwrap_or("1").parse().ok()?;
    if den == 0.0 {
        None
    } else {
        Some(num / den)
    }
}

fn tail(s: &str) -> String {
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("")
        .to_string()
}
