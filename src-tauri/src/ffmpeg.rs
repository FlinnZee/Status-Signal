//! Thin async wrappers over the bundled ffmpeg/ffprobe sidecars.
//!
//! Two execution shapes:
//!   * [`capture`]    — run to completion, collect all stdout/stderr (ffprobe).
//!   * [`run_encode`] — stream ffmpeg's `-progress pipe:1` output and emit
//!                      structured progress events to the frontend.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Sidecar basenames. NOTE: these are the *runtime* names, not the `externalBin`
/// paths. Tauri's CLI takes the `externalBin` source (`binaries/ffmpeg-<triple>`)
/// and copies it FLAT next to the app executable as `ffmpeg.exe`. At runtime the
/// shell plugin resolves a sidecar by joining the exe's directory with the name
/// given here (+ platform ext) — so it must be the bare basename. Using the
/// `binaries/` prefix here points at a non-existent subfolder (Windows os error 3).
pub const FFMPEG: &str = "ffmpeg";
pub const FFPROBE: &str = "ffprobe";

/// Result of a run-to-completion sidecar invocation.
pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Run a sidecar to completion and capture its output. Used for ffprobe, whose
/// JSON output is small and arrives all at once.
pub async fn capture(app: &AppHandle, bin: &str, args: Vec<String>) -> Result<Captured, String> {
    let cmd = app
        .shell()
        .sidecar(bin)
        .map_err(|e| format!("sidecar '{bin}' not found: {e} (run `pnpm fetch:ffmpeg`?)"))?;
    let (mut rx, _child) = cmd.args(args).spawn().map_err(|e| e.to_string())?;

    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let mut code = -1;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => out.extend_from_slice(&bytes),
            CommandEvent::Stderr(bytes) => err.extend_from_slice(&bytes),
            CommandEvent::Terminated(payload) => code = payload.code.unwrap_or(-1),
            CommandEvent::Error(e) => return Err(e),
            _ => {}
        }
    }

    Ok(Captured {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        code,
    })
}

/// Progress event payload pushed to the frontend on `encode://progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    percent: f64,
    fps: f64,
    speed: String,
    out_time_ms: f64,
}

/// Run an ffmpeg encode, streaming progress. `args` must include
/// `-progress pipe:1` so ffmpeg writes newline-delimited `key=value` progress to
/// stdout. `duration_us` (from a prior ffprobe pass) turns elapsed output time
/// into a percentage. Errors include the tail of ffmpeg's stderr.
pub async fn run_encode(
    app: &AppHandle,
    args: Vec<String>,
    duration_us: f64,
    job_id: &str,
) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar(FFMPEG)
        .map_err(|e| format!("ffmpeg sidecar not found: {e} (run `pnpm fetch:ffmpeg`?)"))?;
    let (mut rx, _child) = cmd.args(args).spawn().map_err(|e| e.to_string())?;

    let mut stdout_buf = String::new();
    let mut stderr_log = String::new();
    let mut last_fps = 0.0_f64;
    let mut last_speed = String::new();
    let mut code = -1;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                // Drain whole lines; keep any partial line in the buffer.
                while let Some(nl) = stdout_buf.find('\n') {
                    let line: String = stdout_buf.drain(..=nl).collect();
                    handle_progress_line(
                        line.trim(),
                        duration_us,
                        job_id,
                        app,
                        &mut last_fps,
                        &mut last_speed,
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                // With `-loglevel error -nostats`, stderr carries only real errors.
                stderr_log.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(payload) => code = payload.code.unwrap_or(-1),
            CommandEvent::Error(e) => return Err(e),
            _ => {}
        }
    }

    if code != 0 {
        let tail = tail_lines(&stderr_log, 8);
        return Err(if tail.is_empty() {
            format!("ffmpeg exited with code {code}")
        } else {
            format!("ffmpeg failed (code {code}):\n{tail}")
        });
    }
    Ok(())
}

/// Parse one `-progress` line and emit a progress event when output time advances.
fn handle_progress_line(
    line: &str,
    duration_us: f64,
    job_id: &str,
    app: &AppHandle,
    last_fps: &mut f64,
    last_speed: &mut String,
) {
    if let Some(v) = line.strip_prefix("fps=") {
        if let Ok(f) = v.trim().parse::<f64>() {
            *last_fps = f;
        }
    } else if let Some(v) = line.strip_prefix("speed=") {
        *last_speed = v.trim().to_string();
    } else if let Some(us) = parse_out_time_us(line) {
        let percent = if duration_us > 0.0 {
            (us / duration_us * 100.0).clamp(0.0, 99.9)
        } else {
            0.0
        };
        let _ = app.emit(
            "encode://progress",
            Progress {
                job_id: job_id.to_string(),
                percent,
                fps: *last_fps,
                speed: last_speed.clone(),
                out_time_ms: us / 1000.0,
            },
        );
    }
}

/// Extract elapsed output time in microseconds from a progress line.
/// Prefers `out_time_us`; falls back to the `out_time=HH:MM:SS.micros` form.
fn parse_out_time_us(line: &str) -> Option<f64> {
    if let Some(v) = line.strip_prefix("out_time_us=") {
        return v.trim().parse::<f64>().ok();
    }
    if let Some(v) = line.strip_prefix("out_time=") {
        return parse_timecode_us(v.trim());
    }
    None
}

/// "HH:MM:SS.ffffff" → microseconds.
fn parse_timecode_us(tc: &str) -> Option<f64> {
    let mut parts = tc.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 3600.0) + (m * 60.0) + s) * 1_000_000.0)
}

/// Last `n` non-empty lines of a log, oldest-first.
fn tail_lines(log: &str, n: usize) -> String {
    let lines: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}
