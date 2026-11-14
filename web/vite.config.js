import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built site works from any static host or sub-path.
export default defineConfig({
  base: "./",
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), about: resolve(import.meta.dirname, "about.html") },
    },
  },
});
