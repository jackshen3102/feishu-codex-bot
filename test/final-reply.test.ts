import { describe, expect, it } from "vitest";
import { splitFinalReply } from "../src/jobs/final-reply.js";

describe("final reply chunks", () => {
  it("preserves text exactly while respecting UTF-8 byte limits", () => {
    const text = "开头🙂\n" + "汉字 and ASCII 🚀\n".repeat(40) + "结尾";
    const chunks = splitFinalReply(text, 97);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 97)).toBe(true);
    expect(chunks.every((chunk) => !chunk.includes("�"))).toBe(true);
  });

  it("keeps exact-boundary and empty payloads deterministic", () => {
    expect(splitFinalReply("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
    expect(splitFinalReply("", 4)).toEqual([""]);
  });
});
