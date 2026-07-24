import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Prevent vite from obscuring rust errors
  clearScreen: false,

  // Tauri expects a fixed port; fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.dbg/**", "**/debug-*.md"],
    },
  },

  // Optimize monaco-editor (large vendor chunk)
  optimizeDeps: {
    include: ["monaco-editor"],
  },

  // Build configuration for Tauri
  build: {
    // Tauri uses chromium on Windows and WebKit on macOS/Linux
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari14",
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    // Reduce memory pressure during build
    rollupOptions: {
      maxParallelFileOps: 100,
    },
  },
}));
