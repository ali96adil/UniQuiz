import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // All HTTP and WebSocket routes MUST share the isolated rehearsal target.
  // A hardcoded /api or /socket.io default could mutate a running official event.
  const env = loadEnv(mode, ".", "UNIQUIZ_");
  const apiTarget = env.UNIQUIZ_API_PROXY_TARGET || "http://127.0.0.1:8787";
  return {
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/health": {
        target: apiTarget,
      },
      "/api": {
        target: apiTarget,
      },
      "/socket.io": {
        target: apiTarget,
        ws: true,
      },
    },
  },
  };
});
