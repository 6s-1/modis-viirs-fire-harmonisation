import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built site works from any static host or sub-path.
export default defineConfig({
  base: "./",
  // strictPort: the Worker only allows CORS from :5173, so drifting to another port would
  // silently break live mode. Fail loudly instead.
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, "index.html"), about: resolve(import.meta.dirname, "about.html") },
    },
  },
});
