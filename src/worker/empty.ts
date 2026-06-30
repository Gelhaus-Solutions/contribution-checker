// Bundle stub. The worker pulls in app server libs that `import "server-only"`
// (a Next.js client-bundle guard). In the worker (a plain Node process) that
// guard is meaningless, so esbuild aliases "server-only" to this empty module.
export {};
