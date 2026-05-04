export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export async function readLimitedBody(
  req: Request,
  maxBytes: number
): Promise<string> {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new BodyTooLargeError(
        `request body exceeds ${maxBytes} bytes (content-length=${n})`
      );
    }
  }

  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new BodyTooLargeError(
        `request body exceeds ${maxBytes} bytes`
      );
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}
