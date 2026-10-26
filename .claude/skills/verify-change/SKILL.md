---
name: verify-change
description: Pick and run the checks a change to this repository needs before it is committed, pushed, or called done. Use after editing code, tests, the conformance ledger, the web app, or packaging here, and before reporting that a change works.
---

# Verify a change

1. Use Node 24 or later. On Node 22 the SQLite tests fail at startup with `enableDefensive is not a function`.
2. Run `pnpm verify:changed`. It reads what changed since `origin/main` and prints one command per line, each with the reason it was selected. Pass another base branch as an argument when the work is stacked.
3. Run every printed command, or run `pnpm verify:changed --run`, which stops at the first failure. Commands marked "needs Docker" need a running Docker daemon. If one cannot run, say which one and why. Do not skip it silently.
4. If the change touches a hot path (publish, read, list, or staging), also run `pnpm perf:baseline` before and after the change on the same machine.
5. Before you hand off a branch, run `pnpm verify:iteration` or the CI full gate. To run the full gate on a branch, use `gh workflow run ci.yml --ref <branch> -f tier=full`. Pull-request CI skips it.

## Reading failures

- A test that fails only in a full parallel run and passes alone is load or timing. Confirm by running it alone three times before you blame the change.
- `conformance:tests` allows one test per requirement ID. Add new cases to the existing test that owns the ID, or add a ledger row with a new ID.
- When you change behavior, check that the test fails with the change reverted. A test that passes either way proves nothing.

Report each command with its result. Name any command you did not run, and give the reason.
