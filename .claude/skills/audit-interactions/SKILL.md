---
name: audit-interactions
description: Hunt for bugs that appear only when several merged features meet, which single-PR reviews miss. Use after a batch of features lands, before a release, or when asked to find bugs, audit, or harden the server.
---

# Audit how features interact

Single-PR review checks a change against itself. Most bugs it misses live where two merged features meet. One run of this audit found an owner email leaking through a new endpoint, because the endpoint skipped a filter that an older one applied. It also found a redirect that was right for signed-out readers but bounced signed-in members.

1. List the features merged since the last audit: `git log --merges --oneline <since>..origin/main`.
2. For each pair that shares a surface, ask what one assumes the other never does. Shared surfaces: a route, a cache header, a session, a rule, a stored field, a config value.
   - **Data shown to anonymous readers.** Does every response that carries a field apply the same filter? Owner names, emails and IDs are the usual leaks.
   - **The same rule on every surface.** REST, MCP, the home tree, the viewer bar and the CLI must agree on who may do what.
   - **Caching.** Can a redirect or response cached for one reader reach another reader, or outlive a rename or visibility change?
   - **Config.** For each setting, do the Helm schema, the env parser and `config check` accept exactly the same values?
   - **Storage.** Can an older build open a newer database? Can a retry change an ID? Does cleanup delete bytes that something still references?
   - **Lifecycle.** What happens on shutdown, on restart, and when a client retries after a lost response?
3. Confirm each suspicion by reading the exact code path, and by a small test against a real temporary server where that is cheap. Report only what you confirmed, with a reproduction and the smallest fix.
4. Fix each finding in its own commit, each with a test that fails before the fix. Run the `verify-change` skill, and for storage findings the `prove-on-postgres` skill.
