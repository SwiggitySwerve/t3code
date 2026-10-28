import { describe, expect, it } from "vite-plus/test";

import { formatElapsedSeconds } from "./AgentElapsed";

describe("formatElapsedSeconds", () => {
  it("leaves zero parts out and pads nothing, as the node cards do", () => {
    expect(formatElapsedSeconds(41)).toBe("41s");
    expect(formatElapsedSeconds(96)).toBe("1m 36s");
    expect(formatElapsedSeconds(120)).toBe("2m");
    expect(formatElapsedSeconds(62)).toBe("1m 2s");
    expect(formatElapsedSeconds(3720)).toBe("1h 2m");
    expect(formatElapsedSeconds(7200)).toBe("2h");
  });
});
