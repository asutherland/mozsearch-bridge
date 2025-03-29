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
    }),
    // For LineUpJS the npm module includes the transpiled/bundled version that
    // gets published on unpkg.  We use symlinks to explicitly pick files from
    // this to be put in the build dir.
    //
    // This is sort of an older-school jquery / script tag form of dev where
    // we're giving up some IDE integration.  The transpiled JS versions of the
    // files from the source typescript files are also availble in build, and
    // could potentially be used at the trade-off of the bundler doing a lot
    // more bundling.  That said, note that the vis-timeline is already getting
    // pulled in via the bundler.  I'm making this decision currently because
    // I think it's likely the decision that will be made for searchfox which
    // very much is just using script tags.
    copyStaticFiles({
      src: "./vendoring-symlinks",
      dest: "./build",
    })
  ]
});
