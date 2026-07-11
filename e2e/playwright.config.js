// E2E config — expects the frontend on :8000 and backend on :8001
// (started by run_e2e.sh, or your already-running dev servers).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.js",
  timeout: 90_000,
  retries: 1,
  workers: 1, // sequential — tests share the demo athlete's real-time pacing
  use: {
    baseURL: "http://localhost:8000",
    viewport: { width: 1280, height: 900 },
  },
  reporter: [["list"]],
});
