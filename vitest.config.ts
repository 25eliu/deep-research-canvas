import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  esbuild: { jsx: "automatic" }, // Next's tsconfig says "preserve"; tests need real JSX transform
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
    environmentMatchGlobs: [["components/**", "jsdom"]],
  },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
