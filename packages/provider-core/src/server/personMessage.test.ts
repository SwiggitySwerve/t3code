import { describe, expect, it } from "vite-plus/test";

import { isPersonTypedMessage } from "./personMessage.ts";

describe("isPersonTypedMessage", () => {
  it("accepts a user message from the web or mobile client", () => {
    for (const creationSource of ["web", "mobile"] as const) {
      expect(isPersonTypedMessage({ createdBy: "user", creationSource })).toBe(true);
    }
  });

  it("refuses every other author or source", () => {
    for (const createdBy of ["agent", "system"] as const) {
      for (const creationSource of ["web", "mobile", "mcp", "provider", "server"] as const) {
        expect(
          isPersonTypedMessage({ createdBy, creationSource }),
          `${createdBy}/${creationSource}`,
        ).toBe(false);
      }
    }
    for (const creationSource of ["mcp", "provider", "server"] as const) {
      expect(isPersonTypedMessage({ createdBy: "user", creationSource })).toBe(false);
    }
  });

  it("refuses a message a schedule or another thread sent through a client path", () => {
    const base = { createdBy: "user", creationSource: "web" } as const;
    expect(isPersonTypedMessage({ ...base, scheduledTaskId: "task-1" })).toBe(false);
    expect(isPersonTypedMessage({ ...base, senderThreadId: "thread-1" })).toBe(false);
  });
});
