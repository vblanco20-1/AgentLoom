import { describe, it, expect } from "bun:test";
import { ascendingMessageId } from "../src/util/uuid.ts";

describe("ascendingMessageId", () => {
  it("starts with the msg_ prefix opencode validates", () => {
    expect(ascendingMessageId().startsWith("msg_")).toBe(true);
  });

  it("has the same shape as opencode-generated message IDs (msg_ + 12 hex + 14 base62)", () => {
    // opencode (packages/opencode/src/id/id.ts) builds IDs as
    // `prefix + "_" + 6 bytes hex + randomBase62(14)`. Matching this
    // format means our IDs and opencode's are directly comparable
    // lexicographically — and since we generate strictly before
    // opencode does for any given prompt, our timestamp prefix is
    // strictly less, keeping the `lastUser.id < lastAssistant.id`
    // invariant in opencode's runLoop break condition.
    const id = ascendingMessageId();
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("produces strictly ascending IDs in generation order", () => {
    // The runLoop break check is a string compare; the counter inside
    // the generator guarantees ascending within the same ms.
    const ids = Array.from({ length: 100 }, () => ascendingMessageId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]! < ids[i]!).toBe(true);
    }
  });
});
