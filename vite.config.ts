import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The OCCT glue file loads its own .wasm; pre-bundling it breaks the URL.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
  // three.js alone is ~600 kB minified; the kernel .wasm is a separate asset.
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
