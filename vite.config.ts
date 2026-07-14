import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ["monaco-editor"],
  },

  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 5174,
      }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.dbg/**", "**/debug-*.md"],
    },
  },
}));
