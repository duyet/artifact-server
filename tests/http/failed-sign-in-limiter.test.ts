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

  test("foundation: a spray of new keys past capacity cannot evict a locked-out key and reset its count", () => {
    const clock = new SteppedClock();
    const limiter = new FailedSignInLimiter(clock, {
      maximumAddresses: 3,
      maximumFailures: 5,
      windowMilliseconds: 60_000,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) limiter.recordFailure("alice");
    for (let junk = 0; junk < 10; junk += 1) {
      clock.milliseconds += 1;
      limiter.recordFailure(`junk${junk}`);
    }

    expect(limiter.retryAfterSeconds("alice")).toBe(60);
  });
});
