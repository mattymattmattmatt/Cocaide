import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the production build in Chromium. WebGL runs on
// SwiftShader so they also run on machines without a GPU.
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "out/e2e",
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1500, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1500, height: 900 },
        launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
  webServer: {
    command: "npx vite build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
