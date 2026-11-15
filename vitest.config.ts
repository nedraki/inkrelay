import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "@inkrelay/core": resolve("packages/core/src/index.ts"),
    "@inkrelay/action-router": resolve("packages/action-router/src/index.ts"),
    "@inkrelay/render-svg": resolve("packages/render-svg/src/index.ts"),
    "@inkrelay/render-excalidraw": resolve("packages/render-excalidraw/src/index.ts"),
    "@inkrelay/obsidian-writer": resolve("packages/obsidian-writer/src/index.ts"),
    "@inkrelay/adapters": resolve("packages/adapters/src/index.ts"),
    "@inkrelay/workflows": resolve("packages/workflows/src/index.ts")
  } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "html"] }
  }
});
