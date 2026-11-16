import { defineConfig } from "vite";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The About page shows a photo at design/shreya.jpg if that file is there, and initials if it is
// not. web/design/ holds working files and is not served, so this copies the one file across.
const PHOTO = resolve(import.meta.dirname, "design/shreya.jpg");
const photo = () => ({
  name: "team-photo",
  configureServer(server) {
    server.middlewares.use("/design/shreya.jpg", (req, res, next) => {
      if (!existsSync(PHOTO)) return next();
      res.setHeader("Content-Type", "image/jpeg");
      res.end(readFileSync(PHOTO));
    });
  },
  closeBundle() {
    if (!existsSync(PHOTO)) return;
    mkdirSync(resolve(import.meta.dirname, "dist/design"), { recursive: true });
    copyFileSync(PHOTO, resolve(import.meta.dirname, "dist/design/shreya.jpg"));
  },
});

// Relative base so the built site works from any static host or sub-path.
export default defineConfig({
  base: "./",
  plugins: [photo()],
  // strictPort: the Worker only allows CORS from :5173, so drifting to another port would
  // silently break live mode. Fail loudly instead.
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        // index.html is the dashboard; app.html and about.html are redirect stubs that keep
        // older shared links working.
        app: resolve(import.meta.dirname, "index.html"),
        legacyApp: resolve(import.meta.dirname, "app.html"),
        about: resolve(import.meta.dirname, "about.html"),
      },
    },
  },
});
