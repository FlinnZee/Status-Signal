//! PureSignal — WhatsApp Status video quality optimizer.
//!
//! The Rust side owns the bundled ffmpeg/ffprobe sidecars: it inspects source
//! files (ffprobe), runs the high-effort conform encode (ffmpeg, the v2 recipe
//! from DESIGN.md §3), streams progress to the UI, and measures
//! WhatsApp-processed clips for recalibration. The web frontend is presentation
//! only.

mod commands;
mod config;
mod encode;
mod ffmpeg;
mod probe;

/// Build and run the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::probe_file,
            commands::encode_file,
            commands::probe_recalibrate,
            commands::get_config,
            commands::save_config,
            commands::reset_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PureSignal");
}
