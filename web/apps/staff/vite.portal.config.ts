import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  build: {
    outDir: "dist-portal",
    rollupOptions: { input: "portal.html" }
  }
});
