import { defineConfig } from "vite";

// Tauri expects a fixed dev port and a predictable build output directory.
// 1420 is Tauri's default devUrl port (see src-tauri/tauri.conf.json).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Relative base so the built assets load correctly from the Tauri webview.
  base: "./",

  // Don't clear the screen — we want to keep the Rust compiler / ffmpeg logs visible.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Rust sources are watched by the Tauri CLI, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Match the WebView2 / WKWebView baselines Tauri ships with.
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
