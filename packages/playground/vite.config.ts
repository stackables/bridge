import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@stackables/bridge-core": fileURLToPath(new URL("../bridge-core/src/index.ts", import.meta.url)),
      "@stackables/bridge-stdlib": fileURLToPath(new URL("../bridge-stdlib/src/index.ts", import.meta.url)),
      "@stackables/bridge-compiler": fileURLToPath(new URL("../bridge-compiler/src/index.ts", import.meta.url)),
      "@stackables/bridge-graphql": fileURLToPath(new URL("../bridge-graphql/src/index.ts", import.meta.url)),
      "@stackables/bridge": fileURLToPath(new URL("../bridge/src/index.ts", import.meta.url)),
    },
  },
});
