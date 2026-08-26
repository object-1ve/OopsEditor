import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

const materialIconsDir = path.resolve(__dirname, "node_modules/material-icon-theme/icons");

function materialIconAssets(): Plugin {
  return {
    name: "material-icon-theme-assets",
    configureServer(server) {
      server.middlewares.use("/material-icon-theme-icons", (request, response, next) => {
        const fileName = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
          .replace(/^\/+/, "");
        if (!fileName || fileName !== path.basename(fileName) || !fileName.endsWith(".svg")) {
          next();
          return;
        }

        const filePath = path.join(materialIconsDir, fileName);
        if (!fs.existsSync(filePath)) {
          next();
          return;
        }

        response.setHeader("Content-Type", "image/svg+xml");
        response.end(fs.readFileSync(filePath));
      });
    },
    generateBundle() {
      for (const fileName of fs.readdirSync(materialIconsDir)) {
        if (!fileName.endsWith(".svg")) continue;
        this.emitFile({
          type: "asset",
          fileName: `material-icon-theme-icons/${fileName}`,
          source: fs.readFileSync(path.join(materialIconsDir, fileName)),
        });
      }
    },
  };
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), materialIconAssets()],

  // Prevent vite from obscuring rust errors
  clearScreen: false,

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Tauri expects a fixed port; fail if that port is not available
  server: {
    port: 4222,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 4223,
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
    minify: !process.env.TAURI_DEBUG ? ("esbuild" as const) : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    // Reduce memory pressure during build
    rollupOptions: {
      maxParallelFileOps: 100,
    },
  },
}));
