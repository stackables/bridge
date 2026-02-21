/**
 * esbuild bundler for the Bridge Language extension.
 *
 * Produces two outputs:
 *   build/extension.js  — VS Code extension host entry (CJS, vscode external)
 *   build/server.js     — Language server process (CJS, fully self-contained)
 *
 * Run:  node build.mjs
 * Watch: node build.mjs --watch
 */
import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const sharedOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

if (isWatch) {
  // Watch mode: two separate contexts
  const [ctxExt, ctxSrv] = await Promise.all([
    esbuild.context({
      ...sharedOptions,
      entryPoints: ["src/extension.ts"],
      outfile: "build/extension.js",
      external: ["vscode"],
    }),
    esbuild.context({
      ...sharedOptions,
      entryPoints: ["src/server.ts"],
      outfile: "build/server.js",
    }),
  ]);
  await Promise.all([ctxExt.watch(), ctxSrv.watch()]);
  console.log("Watching for changes…");
} else {
  await Promise.all([
    esbuild.build({
      ...sharedOptions,
      entryPoints: ["src/extension.ts"],
      outfile: "build/extension.js",
      external: ["vscode"],
    }),
    esbuild.build({
      ...sharedOptions,
      entryPoints: ["src/server.ts"],
      outfile: "build/server.js",
    }),
  ]);
  console.log("Build complete.");
}
