export const FINAL_REPLY_CHUNK_BYTES = 24 * 1024;

/** Split text without breaking Unicode code points; concatenating the result is lossless. */
export function splitFinalReply(text: string, maximumBytes = FINAL_REPLY_CHUNK_BYTES): string[] {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4) throw new Error("final reply chunk limit is invalid");
  if (text.length === 0) return [text];

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (current && currentBytes + codePointBytes > maximumBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    if (codePointBytes > maximumBytes) throw new Error("final reply chunk limit cannot hold a Unicode code point");
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
