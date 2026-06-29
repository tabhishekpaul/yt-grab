import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  // Prevent Vite from obscuring Rust errors and clearing the screen
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust source tree
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri expects a fixed output dir; env-driven for flexibility
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri's webviews (WKWebView, WebView2, WebKitGTK) are all modern, so we
    // can ship modern JS without down-leveling.
    target: "esnext",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
