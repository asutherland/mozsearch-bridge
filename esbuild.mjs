import * as esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";

// Our background script and UI page can be modules.
await esbuild.build({
  entryPoints: {
    background: './src/index-background.js',
    simple: './src/index-simple.js',
  },
  format: "esm",
  platform: "browser",
  target: "esnext",
  bundle: true,
  write: true,
  outdir: "build",
  resolveExtensions: [".js"],
  banner: {
    js: "// THIS IS A GENERATED FILE, DO NOT EDIT DIRECTLY",
  },
});

// The content script is an IIFE for now, but doesn't really have to be.
await esbuild.build({
  entryPoints: {
    inject: './src/index-inject.js',
  },
  format: "iife",
  platform: "browser",
  target: "esnext",
  bundle: true,
  write: true,
  outdir: "build",
  resolveExtensions: [".js"],
  globalName: "WorkshopBackend",
  banner: {
    js: "// THIS IS A GENERATED FILE, DO NOT EDIT DIRECTLY",
  },
  plugins: [
    copyStaticFiles({
      src: "./static",
      dest: "./build",
    })
  ]
});
