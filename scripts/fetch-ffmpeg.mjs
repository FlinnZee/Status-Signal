#!/usr/bin/env node
/**
 * Fetch static ffmpeg + ffprobe binaries for the current platform and drop them
 * into src-tauri/binaries/ with the Rust target-triple suffix Tauri expects for
 * sidecars (e.g. `ffmpeg-x86_64-pc-windows-msvc.exe`).
 *
 * Keeping these out of git (see .gitignore) keeps the repo lean; this script
 * repopulates them on any fresh clone. No third-party npm deps — extraction
 * shells out to the platform's own unzip/tar.
 *
 *   node scripts/fetch-ffmpeg.mjs           # fetch if missing
 *   node scripts/fetch-ffmpeg.mjs --force   # re-fetch even if present
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm, chmod, copyFile, readdir, stat, access } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = path.join(ROOT, "src-tauri", "binaries");
const FORCE = process.argv.includes("--force");

/* ---- Where to get static builds, keyed by Rust target triple ---- */
const SOURCES = {
  "x86_64-pc-windows-msvc": {
    archives: [
      { url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip", type: "zip" },
    ],
  },
  "aarch64-pc-windows-msvc": {
    archives: [
      { url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-gpl.zip", type: "zip" },
    ],
  },
  "x86_64-apple-darwin": {
    archives: [
      { url: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip", type: "zip" },
      { url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip", type: "zip" },
    ],
  },
  "aarch64-apple-darwin": {
    // evermeet ships x86_64 builds; they run fine under Rosetta as a separate
    // process. Swap in native arm64 builds here if you want to avoid Rosetta.
    archives: [
      { url: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip", type: "zip" },
      { url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip", type: "zip" },
    ],
    note: "macOS arm64: using x86_64 ffmpeg (runs via Rosetta). Replace with native arm64 builds if preferred.",
  },
  "x86_64-unknown-linux-gnu": {
    archives: [
      { url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz", type: "tarxz" },
    ],
  },
  "aarch64-unknown-linux-gnu": {
    archives: [
      { url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz", type: "tarxz" },
    ],
  },
};

main().catch((err) => {
  console.error("\n✖ fetch-ffmpeg failed:", err.message || err);
  process.exit(1);
});

async function main() {
  const triple = hostTriple();
  const isWin = process.platform === "win32";
  const ext = isWin ? ".exe" : "";
  console.log(`• target triple: ${triple}`);

  const source = SOURCES[triple];
  if (!source) {
    throw new Error(
      `no ffmpeg source configured for ${triple}. Add one to scripts/fetch-ffmpeg.mjs ` +
        `or place ffmpeg${ext}/ffprobe${ext} manually in src-tauri/binaries/ with the ` +
        `-${triple}${ext} suffix.`
    );
  }
  if (source.note) console.log(`  note: ${source.note}`);

  const targets = {
    ffmpeg: path.join(BIN_DIR, `ffmpeg-${triple}${ext}`),
    ffprobe: path.join(BIN_DIR, `ffprobe-${triple}${ext}`),
  };

  if (!FORCE && (await exists(targets.ffmpeg)) && (await exists(targets.ffprobe))) {
    console.log("✓ ffmpeg + ffprobe already present (use --force to re-fetch).");
    return;
  }

  await mkdir(BIN_DIR, { recursive: true });
  const work = path.join(os.tmpdir(), `puresignal-ffmpeg-${Date.now()}`);
  await mkdir(work, { recursive: true });

  try {
    let i = 0;
    for (const archive of source.archives) {
      const file = path.join(work, `dl-${i++}.${archive.type === "zip" ? "zip" : "tar.xz"}`);
      console.log(`• downloading ${archive.url}`);
      await download(archive.url, file);
      console.log(`• extracting ${path.basename(file)}`);
      await extract(file, archive.type, work);
    }

    // Find the binaries anywhere in the extracted tree (folder names carry
    // version numbers, so we search rather than hardcode paths).
    const found = await findBinaries(work, ext);
    for (const name of ["ffmpeg", "ffprobe"]) {
      if (!found[name]) {
        throw new Error(`could not locate ${name}${ext} inside the downloaded archive(s).`);
      }
      await copyFile(found[name], targets[name]);
      if (!isWin) await chmod(targets[name], 0o755);
      console.log(`✓ ${path.basename(targets[name])}`);
    }
    console.log("\n✓ ffmpeg sidecars ready in src-tauri/binaries/");
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---- helpers ---- */

function hostTriple() {
  // Prefer rustc's own host triple when available (most accurate); else map.
  const probe = spawnSync("rustc", ["-Vv"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout) {
    const m = probe.stdout.match(/host:\s*(\S+)/);
    if (m) return m[1];
  }
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return a === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported platform: ${p}/${a}`);
}

async function download(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "PureSignal-setup" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function extract(file, type, dir) {
  if (type === "zip") {
    if (process.platform === "win32") {
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dir}' -Force`,
      ]);
    } else {
      run("unzip", ["-o", file, "-d", dir]);
    }
  } else if (type === "tarxz") {
    run("tar", ["-xJf", file, "-C", dir]);
  } else {
    throw new Error(`unknown archive type: ${type}`);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) throw new Error(`${cmd} not available: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
}

async function findBinaries(dir, ext) {
  const wanted = {
    [`ffmpeg${ext}`]: "ffmpeg",
    [`ffprobe${ext}`]: "ffprobe",
  };
  const result = {};
  for await (const file of walk(dir)) {
    const base = path.basename(file).toLowerCase();
    if (wanted[base] && !result[wanted[base]]) {
      result[wanted[base]] = file;
    }
  }
  return result;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function exists(p) {
  try {
    await access(p);
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}
