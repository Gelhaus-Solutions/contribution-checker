import { Script, createContext } from "node:vm";

export class RegexTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 50;

const COMPILED_SCRIPT = new Script(
  "Boolean(new RegExp(__pattern, __flags).test(__input))"
);

export function safeRegexTest(args: {
  pattern: string;
  flags?: string;
  input: string;
  timeoutMs?: number;
}): boolean {
  const ctx = createContext({
    __input: args.input,
    __pattern: args.pattern,
    __flags: args.flags ?? "",
  });
  try {
    return Boolean(
      COMPILED_SCRIPT.runInContext(ctx, {
        timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
    );
  } catch (e) {
    if (
      e instanceof Error &&
      /Script execution timed out/i.test(e.message)
    ) {
      throw new RegexTimeoutError(
        `regex evaluation exceeded ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      );
    }
    throw e;
  }
}
