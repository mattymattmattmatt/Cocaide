import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// With ANTHROPIC_API_KEY set, `npm run dev` proxies /anthropic to the API and
// adds the key on the server side, so the page never holds it.
const apiKey = process.env.ANTHROPIC_API_KEY;
// Tells the page it can ask without a key of its own (VITE_ variables reach import.meta.env).
process.env.VITE_COCAIDE_ANTHROPIC_PROXY = apiKey ? "1" : "";

export default defineConfig({
  // Served from a subpath (GitHub Pages: /<repo>/), every URL the build writes starts with it.
  base: process.env.COCAIDE_BASE ?? "/",
  plugins: [react()],
  // The OCCT glue file loads its own .wasm; pre-bundling it breaks the URL.
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
  // three.js alone is ~600 kB minified; the kernel .wasm is a separate asset.
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
  server: apiKey
    ? {
        proxy: {
          "/anthropic": {
            target: "https://api.anthropic.com",
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/anthropic/, ""),
            configure: (proxy) => {
              proxy.on("proxyReq", (req) => {
                req.setHeader("x-api-key", apiKey);
                req.removeHeader("anthropic-dangerous-direct-browser-access");
              });
            },
          },
        },
      }
    : {},
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
