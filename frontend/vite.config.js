import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the build works from any path (GitHub Pages project site, Render static, IPFS).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { fs: { allow: [".."] } },
});
