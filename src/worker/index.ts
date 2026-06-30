/**
 * Worker entrypoint. Run as a second process beside `next start`:
 *
 *   tsx -r tsconfig-paths/register src/worker/index.ts
 *
 * (tsconfig-paths makes the `@/` alias resolve at runtime; dotenv loads the same
 * .env files the Next.js app uses. Both must run BEFORE any module that reads
 * env or imports app code, so this file does only that, then hands off to
 * ./run via a dynamic import.)
 */
import { config as loadEnv } from "dotenv";

// .env.local wins over .env (dotenv never overrides already-set vars), matching
// the Next.js precedence closely enough for the worker's needs. In Docker the
// vars come from the container environment and these files are simply absent.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import("./run").catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
