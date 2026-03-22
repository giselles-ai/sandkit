import { describe, expect, test } from "bun:test";

import { isStreamOpenFailureFatal } from "./openclaw-run-stream";

describe("openclaw run stream helpers", () => {
  test("classifies stream open failures as permanent for 404 and 5xx", () => {
    expect(isStreamOpenFailureFatal(404)).toBe(true);
    expect(isStreamOpenFailureFatal(500)).toBe(true);
    expect(isStreamOpenFailureFatal(503)).toBe(true);
  });

  test("does not classify transient stream open failures as permanent", () => {
    expect(isStreamOpenFailureFatal(408)).toBe(false);
    expect(isStreamOpenFailureFatal(429)).toBe(false);
    expect(isStreamOpenFailureFatal(undefined)).toBe(false);
  });
});
