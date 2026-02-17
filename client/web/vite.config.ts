import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        modelLab: resolve(__dirname, "model-lab.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/tests/**/*.test.ts"],
  },
});
