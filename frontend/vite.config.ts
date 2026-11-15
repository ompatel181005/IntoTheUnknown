import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The synthetic dev fixture is never an input to the production build.
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: "index.html", learn: "learn.html" } } },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000", "/frames": "http://localhost:8000" },
  },
});
