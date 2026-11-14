import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `dev.html` (dev fixture page) is served by the dev server only. The production build
// uses the default input, index.html.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000", "/frames": "http://localhost:8000" },
  },
});
