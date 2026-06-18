/* =====================================================================
   Thin wrapper around the Tauri command/event surface.
   Keeping every `invoke()` string in one file means the JS<->Rust
   contract is documented in a single place.
   ===================================================================== */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/* ---- Source inspection ---- */

/**
 * Probe a source file with ffprobe.
 * @returns {Promise<SourceInfo>} { width, height, fps, codec, profile,
 *          bitrateKbps, durationSec, hasAudio, pixFmt, container }
 */
export function probeFile(path) {
  return invoke("probe_file", { path });
}

/* ---- Encoding ---- */

/**
 * Conform a single file with the v2 recipe. Progress is streamed via the
 * `encode://progress` event (see onEncodeProgress); this promise resolves
 * with the final result once the job finishes.
 *
 * @param {object} job  { jobId, input, options }
 * @returns {Promise<EncodeResult>} { outputs: string[], droppedFrames: number }
 */
export function encodeFile(job) {
  return invoke("encode_file", { job });
}

/** Subscribe to progress events. Returns an unlisten() function. */
export function onEncodeProgress(handler) {
  // payload: { jobId, percent, fps, speed, outTimeMs }
  return listen("encode://progress", (event) => handler(event.payload));
}

/* ---- Probe / recalibration ---- */

/**
 * Measure a WhatsApp-processed clip and diff it against the stored preset.
 * @returns {Promise<ProbeReport>} { target, diff: DiffRow[] }
 */
export function recalibrateFromFile(path) {
  return invoke("probe_recalibrate", { path });
}

/* ---- Config ---- */

/** The active encode preset (resolved defaults + any saved overrides). */
export function getConfig() {
  return invoke("get_config");
}

/** Persist preset overrides. */
export function saveConfig(config) {
  return invoke("save_config", { config });
}

/** Restore the built-in defaults and return them. */
export function resetConfig() {
  return invoke("reset_config");
}

/* ---- OS integration ---- */

/** Reveal a produced file in the system file manager. */
export function revealInFolder(path) {
  return revealItemInDir(path);
}

/** Native file picker for video files. Returns string[] (or [] if cancelled). */
export async function pickVideoFiles({ multiple = true } = {}) {
  const selection = await open({
    multiple,
    directory: false,
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp", "hevc"],
      },
    ],
  });
  if (selection == null) return [];
  return Array.isArray(selection) ? selection : [selection];
}

/* ---- Native OS drag & drop ----
   Tauri delivers file drops at the webview level (not the HTML5 drag API,
   which only yields sandboxed File objects without real paths). This gives
   us absolute paths we can hand straight to ffmpeg. */
export function onFileDrop({ onEnter, onLeave, onDrop }) {
  return getCurrentWebview().onDragDropEvent((event) => {
    const { type } = event.payload;
    if (type === "enter" || type === "over") onEnter?.(event.payload);
    else if (type === "leave") onLeave?.();
    else if (type === "drop") onDrop?.(event.payload.paths || []);
  });
}
