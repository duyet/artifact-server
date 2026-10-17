import {describe, expect, test} from "vitest";

import {FailedSignInLimiter} from "../../src/http/failed-sign-in-limiter.js";

class SteppedClock {
  milliseconds = 0;

  now(): Date {
    return new Date(this.milliseconds);
  }
}

describe("failed sign-in limiter", () => {
  test("foundation: a full table drops expired windows before live ones, and the oldest live window last", () => {
    const clock = new SteppedClock();
    const limiter = new FailedSignInLimiter(clock, {
      maximumAddresses: 2,
      maximumFailures: 1,
      windowMilliseconds: 1_000,
    });

    limiter.recordFailure("expired");
    clock.milliseconds = 500;
    limiter.recordFailure("live");
    clock.milliseconds = 1_200;
    limiter.recordFailure("newest");
    expect([
      limiter.retryAfterSeconds("live"),
      limiter.retryAfterSeconds("newest"),
    ]).toEqual([1, 1]);

    limiter.recordFailure("overflow");
    expect([
      limiter.retryAfterSeconds("live"),
      limiter.retryAfterSeconds("newest"),
      limiter.retryAfterSeconds("overflow"),
    ]).toEqual([null, 1, 1]);
  });
});
