import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// Test only source files, not generated build backups.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
