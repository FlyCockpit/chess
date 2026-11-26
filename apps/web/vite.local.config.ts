import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { videoWorkerOptions } from "./vite.video-worker";
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@locales": path.resolve(import.meta.dirname, "../../packages/locales/src"),
    },
  },
  worker: videoWorkerOptions,
  build: {
    outDir: "dist-local",
    target: "es2022",
    rolldownOptions: { input: path.resolve(import.meta.dirname, "local.html") },
  },
});
