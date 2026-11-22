import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust のビルド出力は監視しない（ロックされたファイルで EBUSY になる）
      ignored: ["**/src-tauri/**"],
    },
  },
});
