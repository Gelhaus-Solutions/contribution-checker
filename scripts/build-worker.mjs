import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bundle the Temporal worker into a single self-contained ESM module.
 *
 * Why bundle instead of running the TS directly with tsx:
 *  - The worker imports the app's server libs, which pull in ESM-only packages
 *    (e.g. @octokit/app). Running the raw .ts graph under Node 24 + tsx hits an
 *    unavoidable require(esm) cycle across the mixed CJS/ESM boundary. Bundling
 *    first-party code into one ESM module removes those cross-module cycles.
 *  - `packages: "external"` keeps node_modules out of the bundle, so native /
 *    file-based deps (@temporalio core-bridge, Prisma engine, Sentry profiler)
 *    load normally at runtime, and ESM-only deps are imported (not require()d)
 *    from the ESM output.
 *  - The "server-only" guard is aliased to an empty module (meaningless in a
 *    plain Node worker).
 *
 * The Temporal workflow code is NOT bundled here: Worker.create compiles it from
 * source at runtime via workflowsPath (see run.ts), so src/worker/workflows must
 * still ship with the image.
 */
await build({
  entryPoints: [path.join(root, "src/worker/index.ts")],
  outfile: path.join(root, "dist/worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  alias: {
    "server-only": path.join(root, "src/worker/empty.ts"),
  },
  // esbuild may emit `require`/`__dirname` for CJS-interop of external deps;
  // ESM output has neither, so shim them from import.meta.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __ftp } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __ftp(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
