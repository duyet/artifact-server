import type {Clock} from "../core/ports.js";

/** Fixed-window bound on failed browser sign-ins from one client address. */
export interface FailedSignInPolicy {
  readonly maximumAddresses: number;
  readonly maximumFailures: number;
  readonly windowMilliseconds: number;
}

export const defaultFailedSignInPolicy: FailedSignInPolicy = {
  maximumAddresses: 10_000,
  maximumFailures: 5,
  windowMilliseconds: 60_000,
};

/** Failed directory sign-ins per username, kept long so a spray across clients stays slow. */
export const directoryUsernameFailedSignInPolicy: FailedSignInPolicy = {
  maximumAddresses: 10_000,
  maximumFailures: 10,
  windowMilliseconds: 15 * 60_000,
};

interface FailureWindow {
  failures: number;
  readonly resetsAt: number;
}

/** In-memory failed sign-in counter for one server process. */
export class FailedSignInLimiter {
  readonly #clock: Clock;
  readonly #policy: FailedSignInPolicy;
  readonly #windows = new Map<string, FailureWindow>();

  constructor(clock: Clock, policy: FailedSignInPolicy = defaultFailedSignInPolicy) {
    this.#clock = clock;
    this.#policy = policy;
  }

  /** Whole seconds until the address may try again, or null when it may try now. */
  retryAfterSeconds(address: string): number | null {
    const now = this.#clock.now().getTime();
    const window = this.#windows.get(address);
    if (window === undefined) return null;
    if (window.resetsAt <= now) {
      this.#windows.delete(address);
      return null;
    }
    return window.failures >= this.#policy.maximumFailures
      ? Math.ceil((window.resetsAt - now) / 1_000)
      : null;
  }

  recordFailure(address: string): void {
    const now = this.#clock.now().getTime();
    const window = this.#windows.get(address);
    if (window !== undefined && window.resetsAt > now) {
      window.failures += 1;
      return;
    }
    this.#windows.delete(address);
    this.#evict(now);
    this.#windows.set(address, {
      failures: 1,
      resetsAt: now + this.#policy.windowMilliseconds,
    });
  }

  /** Return one failure charged to an attempt that refused no credential. */
  refund(address: string): void {
    const window = this.#windows.get(address);
    if (window === undefined || window.resetsAt <= this.#clock.now().getTime()) return;
    window.failures = Math.max(0, window.failures - 1);
  }

  clear(address: string): void {
    this.#windows.delete(address);
  }

  #evict(now: number): void {
    for (const [address, window] of this.#windows) {
      if (window.resetsAt <= now) this.#windows.delete(address);
    }
    // Locked-out keys go last, so a spray of new keys cannot reset a target's count.
    for (const evictLocked of [false, true]) {
      for (const [address, window] of this.#windows) {
        if (this.#windows.size < this.#policy.maximumAddresses) return;
        if ((window.failures >= this.#policy.maximumFailures) === evictLocked) {
          this.#windows.delete(address);
        }
      }
    }
  }
}
