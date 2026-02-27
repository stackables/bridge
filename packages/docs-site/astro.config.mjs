// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightCatppuccin from "@catppuccin/starlight";
import bridgeGrammar from "../bridge-syntax-highlight/syntaxes/bridge.tmLanguage.json" assert { type: "json" };
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import umami from "@yeskunall/astro-umami";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  site: "https://bridge.sdk42.com/",
  vite: {
    plugins: [
      //@ts-expect-error wrong vite verions
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("../playground/src", import.meta.url)),
        "@stackables/bridge-core": fileURLToPath(
          new URL("../bridge-core/src/index.ts", import.meta.url),
        ),
        "@stackables/bridge-stdlib": fileURLToPath(
          new URL("../bridge-stdlib/src/index.ts", import.meta.url),
        ),
        "@stackables/bridge-compiler": fileURLToPath(
          new URL("../bridge-compiler/src/index.ts", import.meta.url),
        ),
        "@stackables/bridge-graphql": fileURLToPath(
          new URL("../bridge-graphql/src/index.ts", import.meta.url),
        ),
        "@stackables/bridge": fileURLToPath(
          new URL("../bridge/src/index.ts", import.meta.url),
        ),
      },
    },
  },
  integrations: [
    starlight({
      title: "The Bridge",
      logo: {
        src: "./src/assets/logo.svg",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/stackables/bridge",
        },
        {
          icon: "npm",
          label: "NPM",
          href: "https://www.npmjs.com/package/@stackables/bridge",
        },
      ],
      expressiveCode: {
        shiki: {
          langs: [
            // @ts-expect-error imported as plain json
            bridgeGrammar,
          ],
        },
      },
      sidebar: [
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Language Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Standard Library",
          autogenerate: { directory: "tools" },
        },
        {
          label: "Advanced Topics",
          autogenerate: { directory: "advanced" },
        },
      ],
      plugins: [
        starlightCatppuccin({
          light: {
            flavor: "latte",
            accent: "blue",
          },
          dark: {
            flavor: "mocha",
            accent: "blue",
          },
        }),
      ],
    }),
    react(),
    umami({ id: "1f6b3965-db14-4b6f-bf61-e6b70f1e0994", tag: "bridge" }),
  ],
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
      persist: true,
    },
  }),
});
