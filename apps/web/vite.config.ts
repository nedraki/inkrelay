import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(process.cwd(), "apps/web"),
  plugins: [react()],
  resolve: { alias: {
    "@inkrelay/core": resolve(process.cwd(), "packages/core/src/index.ts"),
    "@inkrelay/render-excalidraw": resolve(process.cwd(), "packages/render-excalidraw/src/index.ts")
  } },
  server: { port: 4318, proxy: { "/api": "http://127.0.0.1:4317" } },
  build: { outDir: "dist", emptyOutDir: true }
});
