import { config as loadEnv } from "dotenv";

// Load .env BEFORE any module that reads process.env (src/lib/env parses it at
// module-evaluation time). Imported first by index.ts; ESM evaluates this
// module's side effects before the rest of the worker graph. .env.local wins
// over .env (dotenv never overrides already-set vars). In Docker the vars come
// from the container environment and these files are simply absent.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
