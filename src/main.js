/* =====================================================================
   PureSignal — frontend controller.
   Vanilla JS, no framework: a small explicit state object + render
   functions. The heavy lifting (ffprobe/ffmpeg) is all in Rust; this
   file is presentation + orchestration only.
   ===================================================================== */

import {
  probeFile,
  encodeFile,
  onEncodeProgress,
  recalibrateFromFile,
  getConfig,
  saveConfig,
  resetConfig,
  revealInFolder,
  pickVideoFiles,
  onFileDrop,
} from "./lib/api.js";
import {
  basename,
  dirname,
  formatBitrate,
  formatDuration,
  formatFps,
} from "./lib/format.js";

const VIDEO_EXT = new Set([
  "mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp", "hevc", "ts", "mpg", "mpeg",
]);

/* WhatsApp Status splits at 30s; warn (and offer to auto-split) past that. */
const STATUS_MAX_SECONDS = 30;
/* Below this source bitrate, re-encoding can't recover detail that isn't there. */
const LOW_BITRATE_KBPS = 2000;

/** App state. `items` is the conform queue, keyed by jobId. */
const state = {
  mode: "conform",
  items: new Map(), // jobId -> QueueItem
  running: false,
  config: null,
  nextId: 1,
};

const el = {};

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  cacheEls();
  wireModeSwitch();
  wireDropzones();
  wireAdvanced();
  wireActions();
  wireProgressEvents();

  try {
    state.config = await getConfig();
  } catch (err) {
    // Running in a plain browser (vite dev without Tauri) — fall back so the
    // UI still renders for layout work.
    state.config = FALLBACK_CONFIG;
    console.warn("Could not reach backend; using fallback config.", err);
  }
  fillAdvancedFromConfig(state.config);
  renderQueue();
}

function cacheEls() {
  const id = (x) => document.getElementById(x);
  Object.assign(el, {
    panels: document.querySelectorAll("[data-panel]"),
    modeTabs: document.querySelectorAll(".mode-tab"),

    dropzone: id("dropzone"),
    browseBtn: id("browse-btn"),
    queue: id("queue"),
    queueStatus: id("queue-status"),
    startBtn: id("start-btn"),
    clearBtn: id("clear-btn"),

    optBitrate: id("opt-bitrate"),
    optResCap: id("opt-rescap"),
    optFps: id("opt-fps"),
    optSplit: id("opt-split"),
    resetDefaults: id("reset-defaults"),

    probeDrop: id("probe-dropzone"),
    probeBrowse: id("probe-browse-btn"),
    probeResult: id("probe-result"),
  });

  // Toast host
  const host = document.createElement("div");
  host.className = "toast-host";
  document.body.appendChild(host);
  el.toastHost = host;
}

/* ------------------------------------------------------------------ */
/*  Mode switching                                                     */
/* ------------------------------------------------------------------ */

function wireModeSwitch() {
  el.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });
}

function setMode(mode) {
  state.mode = mode;
  el.modeTabs.forEach((t) => {
    const active = t.dataset.mode === mode;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", String(active));
  });
  el.panels.forEach((p) => {
    p.classList.toggle("is-hidden", p.dataset.panel !== mode);
  });
}

/* ------------------------------------------------------------------ */
/*  Drag & drop + browse                                               */
/* ------------------------------------------------------------------ */

function wireDropzones() {
  el.browseBtn.addEventListener("click", async () => {
    const paths = await pickVideoFiles({ multiple: true });
    addToQueue(paths);
  });
  el.probeBrowse.addEventListener("click", async () => {
    const [path] = await pickVideoFiles({ multiple: false });
    if (path) runProbe(path);
  });

  // Native OS file drop (gives real absolute paths).
  onFileDrop({
    onEnter: () => activeDropzone()?.classList.add("is-dragover"),
    onLeave: () => clearDragHighlight(),
    onDrop: (paths) => {
      clearDragHighlight();
      const videos = paths.filter(isVideoPath);
      if (videos.length === 0) {
        toast("No video files in that drop.", "warn");
        return;
      }
      if (state.mode === "probe") runProbe(videos[0]);
      else addToQueue(videos);
    },
  });

  // Keyboard activation of the dropzones (accessibility).
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") el.browseBtn.click();
  });
  el.probeDrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") el.probeBrowse.click();
  });
}

function activeDropzone() {
  return state.mode === "probe" ? el.probeDrop : el.dropzone;
}
function clearDragHighlight() {
  el.dropzone.classList.remove("is-dragover");
  el.probeDrop.classList.remove("is-dragover");
}
function isVideoPath(p) {
  const ext = p.split(".").pop()?.toLowerCase();
  return VIDEO_EXT.has(ext);
}

/* ------------------------------------------------------------------ */
/*  Queue management                                                   */
/* ------------------------------------------------------------------ */

async function addToQueue(paths) {
  const fresh = paths.filter(isVideoPath);
  for (const path of fresh) {
    // Skip exact duplicates already queued.
    if ([...state.items.values()].some((it) => it.input === path)) continue;

    const jobId = `j${state.nextId++}`;
    const item = {
      jobId,
      input: path,
      name: basename(path),
      state: "queued", // queued | probing | running | done | error
      percent: 0,
      info: null,
      warnings: [],
      outputs: [],
      error: null,
      speed: null,
    };
    state.items.set(jobId, item);
    renderQueue();

    // Probe asynchronously so the user sees source info before encoding.
    item.state = "probing";
    try {
      item.info = await probeFile(path);
      item.warnings = deriveWarnings(item.info);
    } catch (err) {
      item.warnings = [];
      console.warn("probe failed", path, err);
    }
    item.state = "queued";
    renderQueue();
  }
}

function deriveWarnings(info) {
  const w = [];
  if (info?.durationSec > STATUS_MAX_SECONDS) {
    w.push(
      state.config?.split
        ? `Clip is ${formatDuration(info.durationSec)} — will be split into ≤30s segments.`
        : `Clip is ${formatDuration(info.durationSec)} — over WhatsApp's 30s limit. Enable splitting in Advanced.`
    );
  }
  if (info?.bitrateKbps && info.bitrateKbps < LOW_BITRATE_KBPS) {
    w.push(
      `Source is already low bitrate (${formatBitrate(
        info.bitrateKbps
      )}) — re-encoding can't add detail that isn't there.`
    );
  }
  return w;
}

function renderQueue() {
  const items = [...state.items.values()];
  el.queue.innerHTML = "";

  for (const it of items) {
    const li = document.createElement("li");
    li.className = "qitem";
    li.dataset.jobId = it.jobId;

    const stateLabel = {
      queued: "Queued",
      probing: "Reading…",
      running: it.percent ? `${it.percent}%` : "Encoding…",
      done: "Done",
      error: "Error",
    }[it.state];
    const stateClass = {
      queued: "is-queued",
      probing: "is-queued",
      running: "is-running",
      done: "is-done",
      error: "is-error",
    }[it.state];

    li.innerHTML = `
      <span class="qitem-name" title="${escapeHtml(it.input)}">${escapeHtml(it.name)}</span>
      <span class="qitem-state ${stateClass}">${stateLabel}</span>
    `;

    if (it.info) {
      const i = it.info;
      const meta = document.createElement("div");
      meta.className = "qitem-meta";
      meta.innerHTML = [
        `${i.width}×${i.height}`,
        `${formatFps(i.fps)} fps`,
        (i.codec || "").toUpperCase(),
        formatBitrate(i.bitrateKbps),
        formatDuration(i.durationSec),
      ]
        .filter(Boolean)
        .map((s) => `<span>${escapeHtml(s)}</span>`)
        .join("");
      li.appendChild(meta);
    }

    for (const warn of it.warnings) {
      const wEl = document.createElement("div");
      wEl.className = "qitem-warn";
      wEl.textContent = "⚠ " + warn;
      li.appendChild(wEl);
    }

    if (it.state === "running" || it.state === "done") {
      const bar = document.createElement("div");
      bar.className = "qitem-progress";
      bar.innerHTML = `<i style="width:${it.state === "done" ? 100 : it.percent}%"></i>`;
      li.appendChild(bar);
    }

    if (it.state === "error" && it.error) {
      const errEl = document.createElement("div");
      errEl.className = "qitem-warn";
      errEl.style.color = "var(--danger)";
      errEl.textContent = it.error;
      li.appendChild(errEl);
    }

    // Per-item actions
    const actions = document.createElement("div");
    actions.className = "qitem-actions";
    if (it.state === "done" && it.outputs.length) {
      const revealBtn = document.createElement("button");
      revealBtn.className = "tiny-btn";
      revealBtn.textContent = "Open folder";
      revealBtn.addEventListener("click", () => revealInFolder(it.outputs[0]));
      actions.appendChild(revealBtn);
      if (it.outputs.length > 1) {
        const note = document.createElement("span");
        note.className = "muted";
        note.style.fontSize = "11px";
        note.style.alignSelf = "center";
        note.textContent = `${it.outputs.length} segments`;
        actions.appendChild(note);
      }
    }
    if (!state.running && (it.state === "queued" || it.state === "done" || it.state === "error")) {
      const rm = document.createElement("button");
      rm.className = "tiny-btn";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        state.items.delete(it.jobId);
        renderQueue();
      });
      actions.appendChild(rm);
    }
    if (actions.children.length) li.appendChild(actions);

    el.queue.appendChild(li);
  }

  // Status line + button states
  const total = items.length;
  const done = items.filter((i) => i.state === "done").length;
  el.queueStatus.textContent = total === 0
    ? "No files queued"
    : state.running
      ? `Processing… ${done}/${total} done`
      : `${total} file${total > 1 ? "s" : ""} queued`;

  const hasPending = items.some((i) => i.state === "queued");
  el.startBtn.disabled = state.running || !hasPending;
  el.clearBtn.disabled = state.running || total === 0;
}

/* ------------------------------------------------------------------ */
/*  Encoding run                                                       */
/* ------------------------------------------------------------------ */

function wireActions() {
  el.startBtn.addEventListener("click", runQueue);
  el.clearBtn.addEventListener("click", () => {
    if (state.running) return;
    state.items.clear();
    renderQueue();
  });
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  renderQueue();

  const options = readOptions();

  for (const it of state.items.values()) {
    if (it.state !== "queued") continue;
    it.state = "running";
    it.percent = 0;
    renderQueue();

    try {
      const result = await encodeFile({
        jobId: it.jobId,
        input: it.input,
        options,
      });
      it.outputs = result.outputs || [];
      it.percent = 100;
      it.state = "done";
      if (typeof result.droppedFrames === "number" && result.droppedFrames > 0) {
        // Acceptance check: we expect drop=0. Surface it if it ever isn't.
        it.warnings.push(`Note: ${result.droppedFrames} frame(s) dropped during encode.`);
      }
    } catch (err) {
      it.state = "error";
      it.error = String(err);
    }
    renderQueue();
  }

  state.running = false;
  renderQueue();
  const okCount = [...state.items.values()].filter((i) => i.state === "done").length;
  if (okCount > 0) toast(`Conformed ${okCount} file${okCount > 1 ? "s" : ""}.`, "ok");
}

function wireProgressEvents() {
  onEncodeProgress((p) => {
    const it = state.items.get(p.jobId);
    if (!it || it.state !== "running") return;
    it.percent = Math.max(0, Math.min(100, Math.round(p.percent)));
    it.speed = p.speed;
    updateItemProgress(it);
  });
}

/** Cheap targeted DOM update so progress doesn't re-render the whole queue. */
function updateItemProgress(it) {
  const li = el.queue.querySelector(`[data-job-id="${it.jobId}"]`);
  if (!li) return;
  const bar = li.querySelector(".qitem-progress > i");
  if (bar) bar.style.width = `${it.percent}%`;
  const stateBadge = li.querySelector(".qitem-state");
  if (stateBadge) stateBadge.textContent = `${it.percent}%`;
}

/* ------------------------------------------------------------------ */
/*  Advanced settings                                                  */
/* ------------------------------------------------------------------ */

function wireAdvanced() {
  const persist = () => {
    const cfg = readOptions();
    state.config = { ...state.config, ...cfg };
    saveConfig(state.config).catch((e) => console.warn("saveConfig failed", e));
    // Splitting affects the >30s warning text — refresh it.
    for (const it of state.items.values()) {
      if (it.info) it.warnings = deriveWarnings(it.info);
    }
    renderQueue();
  };
  [el.optBitrate, el.optResCap, el.optFps, el.optSplit].forEach((node) =>
    node.addEventListener("change", persist)
  );

  el.resetDefaults.addEventListener("click", async () => {
    try {
      state.config = await resetConfig();
      fillAdvancedFromConfig(state.config);
      for (const it of state.items.values()) {
        if (it.info) it.warnings = deriveWarnings(it.info);
      }
      renderQueue();
      toast("Restored default preset.", "ok");
    } catch (e) {
      toast("Couldn't reset preset.", "error");
    }
  });
}

function fillAdvancedFromConfig(cfg) {
  el.optBitrate.value = cfg.bitrateKbps;
  el.optResCap.value = cfg.resCap;
  el.optFps.value = cfg.fpsMode;
  el.optSplit.checked = !!cfg.split;
}

function readOptions() {
  return {
    bitrateKbps: clampInt(el.optBitrate.value, 500, 20000, state.config.bitrateKbps),
    resCap: clampInt(el.optResCap.value, 360, 2160, state.config.resCap),
    fpsMode: el.optFps.value, // "source" | "30" | "60"
    split: el.optSplit.checked,
  };
}

/* ------------------------------------------------------------------ */
/*  Probe / recalibration                                              */
/* ------------------------------------------------------------------ */

async function runProbe(path) {
  el.probeResult.classList.remove("is-hidden");
  el.probeResult.innerHTML = `<p class="muted">Measuring <code>${escapeHtml(
    basename(path)
  )}</code>…</p>`;
  try {
    const report = await recalibrateFromFile(path);
    renderProbeReport(report);
  } catch (err) {
    el.probeResult.innerHTML = `<p style="color:var(--danger)">Probe failed: ${escapeHtml(
      String(err)
    )}</p>`;
  }
}

function renderProbeReport(report) {
  const rows = report.diff
    .map(
      (d) => `
      <tr class="${d.changed ? "diff-changed" : "diff-same"}">
        <td>${escapeHtml(d.label)}</td>
        <td>${escapeHtml(String(d.current))}</td>
        <td>${escapeHtml(String(d.measured))}</td>
        <td>${d.changed ? "→ update" : "same"}</td>
      </tr>`
    )
    .join("");

  const anyChanged = report.diff.some((d) => d.changed);

  el.probeResult.innerHTML = `
    <h3>Measured WhatsApp target</h3>
    <table class="diff-table">
      <thead>
        <tr><th>Property</th><th>Current preset</th><th>Measured</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="probe-actions">
      ${
        anyChanged
          ? `<button id="apply-recal" class="primary-btn">Apply measured values</button>`
          : `<span class="muted">Your preset already matches the measured target.</span>`
      }
    </div>
  `;

  if (anyChanged) {
    document.getElementById("apply-recal").addEventListener("click", async () => {
      try {
        state.config = await saveConfig({ ...state.config, ...report.target });
        fillAdvancedFromConfig(state.config);
        toast("Preset recalibrated to measured target.", "ok");
        el.probeResult.querySelector(".probe-actions").innerHTML =
          `<span class="muted">Applied. Preset updated.</span>`;
      } catch (e) {
        toast("Couldn't apply recalibration.", "error");
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toast(message, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind === "error" ? "is-error" : kind === "warn" ? "is-warn" : ""}`;
  t.textContent = message;
  el.toastHost.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.3s";
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

/* Used only when the backend isn't reachable (plain `vite dev`). Mirrors
   config/defaults.json so the layout still renders in a browser. */
const FALLBACK_CONFIG = {
  bitrateKbps: 6000,
  resCap: 1080,
  fpsMode: "source",
  split: false,
};

// `dirname` is exported from format.js for future use (e.g. output location hints).
void dirname;

boot();
