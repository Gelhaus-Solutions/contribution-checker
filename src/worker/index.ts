/**
 * Worker entrypoint. Run as a second process beside `next start`:
 *
 *   node --import tsx/esm src/worker/index.ts
 *
 * It must run in ESM mode (tsx/esm), not CJS: the worker pulls in the app's
 * server libs which import ESM-only packages (e.g. @octokit/app), and those
 * cannot be require()d from a CommonJS context.
 *
 * Import order matters: ./load-env runs dotenv's side effects, and ESM
 * evaluates it before ./run's subtree (which reads process.env via @/lib/env).
 */
import "./load-env";
import "./run";
