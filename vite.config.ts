import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 与 Electron 共用同一份前端产物：
//   * 开发态：两者都连 http://localhost:5173，端口固定方便对上各自的配置；
//   * 打包态：Tauri 走 tauri:// 自定义协议、Electron 走 file://，
//     所以资源必须用相对路径（base: "./"）——绝对路径 /assets/... 在 file:// 下会 404。
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
