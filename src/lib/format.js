/* Small pure formatting helpers. No DOM, no Tauri — easy to reason about. */

/** Last path segment, handling both `/` and `\` separators. */
export function basename(path) {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Directory portion of a path (everything up to the last separator). */
export function dirname(path) {
  if (!path) return "";
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

/** Bitrate in kbps → "6.0 Mbps" / "630 kbps". */
export function formatBitrate(kbps) {
  if (kbps == null || !isFinite(kbps)) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

/** Seconds → "m:ss" (or "h:mm:ss" past an hour). */
export function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Bytes → human size. */
export function formatBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Frames-per-second as a tidy number ("59.94" → "59.94", "30/1" handled upstream). */
export function formatFps(fps) {
  if (fps == null || !isFinite(fps)) return "—";
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
}
