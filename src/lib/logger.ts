import pino from "pino";
import { env } from "./env";

const VALID_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
const level = VALID_LEVELS.includes(env.LOG_LEVEL as (typeof VALID_LEVELS)[number])
  ? env.LOG_LEVEL
  : "info";

export const logger = pino({
  level,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
