import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PW_PORT ?? 4173);

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
    baseURL: `http://localhost:${PORT}`,
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
    // PW_PORT lets several checkouts (worktrees) run their suites side by side, each against its own build.
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
