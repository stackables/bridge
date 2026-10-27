import type { KnipConfig } from "knip";

// `ignoreExportsUsedInFile` is on only for --production, where tests are out of scope: an
// export a test imports counts as unused there, and one still used inside its own file is
// accepted. The default run keeps it off so such exports are reported.
const production = process.argv.includes("--production");

const config: KnipConfig = {
  include: [
    "files",
    "dependencies",
    "unlisted",
    "binaries",
    "unresolved",
    "exports",
    "types",
    "nsTypes",
    "enumMembers",
    "namespaceMembers",
    "duplicates",
    "cycles",
  ],
  ignoreExportsUsedInFile: production,
  // includeEntryExports stays off: these are published packages, so an entry's exports
  // are used by code knip cannot see.
  workspaces: {
    ".": {
      // scripts/ is run by hand through the root package.json scripts and its own docs.
      entry: ["scripts/*.mjs"],
      // project leaves out loadtest/: standalone Docker projects (own package.json, not
      // pnpm workspace members) whose dependencies knip cannot resolve from this workspace.
      project: ["scripts/**"],
      // The `command` test runner is built into @stryker-mutator/core; knip's stryker
      // plugin wrongly expects a separate @stryker-mutator/command-runner package.
      ignoreDependencies: ["@stryker-mutator/command-runner"],
      // speedscope is an optional global install that flamegraph.mjs falls back around.
      ignoreBinaries: ["speedscope"],
    },
    "packages/bridge": {
      // bench/ is developer tooling run by the bench scripts, not production code: it is
      // in project without the ! so the production run does not report it as unused.
      project: ["src/**!", "test/**", "bench/**"],
    },
    "examples/*": {
      // The start scripts run these; the example is the app, so it is production code.
      // The production run does not follow package.json scripts.
      entry: production ? ["{server,cli}.ts!"] : [],
    },
    "packages/bridge-syntax-highlight": {
      // build.mjs bundles these with esbuild, which knip cannot follow.
      // The production run does not follow package.json scripts, so build.mjs is listed too.
      entry: ["src/extension.ts!", "src/server.ts!", ...(production ? ["build.mjs!"] : [])],
    },
    "packages/docs-site": {
      // wrangler is a devDependency run by the package scripts.
      ignoreBinaries: production ? ["wrangler"] : [],
      // astro.config.mjs (integrations, Vite plugins) and the React islands are loaded
      // by Astro; the production run drops config files, so these look unused there.
      ignoreDependencies: production
        ? [
            "@astrojs/react",
            "@catppuccin/starlight",
            "@tailwindcss/vite",
            "react",
            "react-dom",
          ]
        : [],
    },
  },
};

export default config;
