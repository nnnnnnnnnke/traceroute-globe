import { defineConfig } from "vite";

import { tracerouteApi } from "./server/api";

export default defineConfig({
  plugins: [tracerouteApi()],
  optimizeDeps: {
    // 事前バンドルすると dist/assets への相対URL (WASM/worker/EXR) が壊れるため除外
    exclude: [
      "@navaramap/three",
      "@navaramap/three-default-descs",
      "@navaramap/three-default-plugin",
      "@navaramap/three-plugins",
    ],
  },
});
