import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: ".tmp-test-dist",
    rollupOptions: {
      input: "C:/object1ve/oopseditor/.tmp-test-entry.tsx",
    },
  },
});
