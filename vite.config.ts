import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8756", changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
});
