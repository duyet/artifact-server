---
name: prove-on-postgres
description: Close a conformance requirement's Postgres proof gap by running the behavior against real Postgres and S3, and prove the test can fail. Use when a ledger proof_gap says a Postgres path is untested, after changing a Postgres repository method, or before marking a requirement verified for single_server or kubernetes.
---

# Prove a requirement on Postgres

1. Find the gap: read the requirement's `proof_gap` in `project/spec/conformance.yml` and its SQLite test (`git grep <ID> tests`).
2. Add one `external-storage foundation: ...` test to `tests/integration/external-storage-runtime.test.ts`. Do not reuse the requirement ID, because the SQLite test already owns it. Follow the in-process server tests there. They pin a clock, seed member sessions, and use a unique `installationId` per test.
   - Assert the storage-backed outcomes the SQLite test asserts: rows, counts, ordering, replay, and the hostile cases that must save nothing.
   - For a guard inside a transaction that an application check reaches first, call the `PostgresArtifactRepository` method directly with the state a racing request would hold.
3. Run the suite. Include the migration test, because it creates the schema:
   `bash scripts/with-external-storage-test-providers.sh pnpm exec vitest run --config tests/configs/vitest.external-storage.config.ts -t "explicit apply|<your test>"`
   Run `pnpm build` first.
4. Prove the test can fail. Break the Postgres query or guard it covers, one change at a time, and see the test fail. Then revert, and check that `git diff --stat src` is empty. A break that leaves the test green is a gap: name it in the `proof_gap`.
5. If Postgres and SQLite disagree, you have found a bug. Never weaken the test to match. Fix the query, and keep both stores' behavior identical.
6. Rewrite the `proof_gap` to say exactly what Postgres now runs and what it still does not. Leave `status` alone unless every case and deployment is proved.
7. Before committing, restore `project/evidence` (see `verify-change`), then run `pnpm conformance:validate` and `pnpm conformance:tests`.
