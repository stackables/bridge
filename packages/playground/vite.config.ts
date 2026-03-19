import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath, URL } from "node:url";

const compilerPreviewEnabled =
  process.env.BRIDGE_ENABLE_COMPILER_PREVIEW !== "false";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  define: {
    __BRIDGE_COMPILER_PREVIEW__: JSON.stringify(compilerPreviewEnabled),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@stackables/bridge-core": fileURLToPath(
        new URL("../bridge-core/src/index.ts", import.meta.url),
      ),
      "@stackables/bridge-stdlib": fileURLToPath(
        new URL("../bridge-stdlib/src/index.ts", import.meta.url),
      ),
      "@stackables/bridge-parser": fileURLToPath(
        new URL("../bridge-parser/src/index.ts", import.meta.url),
      ),
      "@stackables/bridge-graphql": fileURLToPath(
        new URL("../bridge-graphql/src/index.ts", import.meta.url),
      ),
      "@stackables/bridge": fileURLToPath(
        new URL("../bridge/src/index.ts", import.meta.url),
      ),
    },
  },
});
