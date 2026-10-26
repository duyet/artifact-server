---
name: review-change
description: Review a diff or pull request in this repository against its own rules (ports, storage parity, idempotency, conformance ledger, test style) before merging. Use when asked to review, approve, or merge a PR here, or before opening one.
---

# Review a change

Read the diff itself (`gh pr diff <n>` or `git diff origin/main...`), not the PR description. Then check each item below. Report findings most severe first, each with `file:line`, a concrete failure scenario, and blocker, should-fix, or nit.

## Repository rules

- **Ports.** Product logic in `src/application` and `src/core` must not import SQLite, Postgres, S3, HTTP, or MCP code. New storage behavior goes through a port in `src/core/ports.ts`.
- **Storage parity.** Every repository method change lands in both `sqlite-artifact-repository.ts` and `postgres-artifact-repository.ts`, with the same rules, ordering, and errors. Check for a test that runs the Postgres path, in `tests/integration/external-storage-runtime.test.ts`.
- **Single use and idempotency.** A command with an idempotency key must replay the same result for the same key and the same input, and must refuse a different input. Anything consumed (an upload, a lease, a login attempt) must be consumed in the same transaction as the write it enables, so a second key cannot reuse it.
- **Concurrency.** Ask what happens when two requests, or two processes on Postgres, run the step at once. Application-level checks are only hints. The guarantee must come from the transaction, a conditional update, or a lock.
- **Untrusted input.** Paths, hostnames, tokens, usernames, and installation IDs never select a raw storage location, a DN, or a query fragment without escaping or a fixed template.
- **Retention.** Before a change deletes stored rows or bytes, read the product spec's retention rule and the backup section of `docs/fork/DESIGN.md`. In the first release, expiry cleanup is the only path that deletes staging bytes, and nothing collects blobs.
- **Visibility.** Anything served to anonymous viewers must filter out private, unlisted, and deleted artifacts, including counts and aggregates.

## Tests and ledger

- New behavior has a test named with its requirement ID (`FRK-019-F: ...`). One test per ID; extra cases join the owning test.
- No `vi.mock` or other module mocks. Tests use real services, temporary SQLite databases, temporary disk, and real HTTP.
- Browser tests that depend on today's date pin both clocks: the server clock, and `page.clock` in the browser.
- The `conformance.yml` entry's description and `proof_gap` match what the tests now prove.

## Simplicity

This project aims to stay small. Flag one-caller wrappers, new layers, new dependencies without a clear need, and configuration nobody asked for. Recommend deleting code where deleting it works.

Finish by running the `verify-change` skill's commands, or by naming the ones CI already ran green on the PR's head commit.
