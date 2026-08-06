# Cloudflare Worker API maintenance and Drizzle v1 upgrade runbook

This runbook covers upgrades of the Worker-safe Postgres schema-diff API described in [WORKER_API.md](./WORKER_API.md). Treat an upgrade as a migration of the snapshot and DDL contracts, not only as a dependency bump: those contracts are internal to Drizzle Kit and can change between releases.

The preferred end state is to use an official Worker-safe Drizzle API and delete this fork-specific surface. Until upstream provides the same runtime and behavior, keep the official `drizzle-kit` dependency for the normal CLI and install this fork under a separate package name or npm alias for Worker code. Pin exact versions of both `drizzle-orm` and the Worker package.

## Current baseline

As of 2026-08-06, the Worker patch is on branch `codex/cloudflare-worker-api` in `gonzalovargas/drizzle-orm`:

- `83f3ba7f` adds the Worker-safe Postgres API.
- `7442a1ec` hardens runtime hint validation, packaging, tests, and documentation.
- The baseline is Drizzle `1.0.0-rc.4`.

At that baseline, the focused Worker tests passed 14/14, CLI and non-TTY regression tests passed 48/48, typecheck/lint/build passed, and a packed consumer bundled and ran in Wrangler without `nodejs_compat`. The complete Postgres suite had 749 passing, 8 failing, and 1 skipped test; the failures were pre-existing environment, assertion, or database-integration cases outside the changed paths. Re-run the checks below rather than treating these numbers as permanent guarantees.

## Decide what to do when Drizzle v1 is available

Before changing dependencies, inspect the v1 release, export map, implementation, and tests. Verify whether upstream provides all of the following:

- an ESM entry that accepts in-memory Postgres schema exports;
- snapshot generation and snapshot-to-snapshot SQL generation;
- non-interactive, serializable rename/create decisions;
- a structured error when a required decision is missing;
- no filesystem access, prompts, `process.exit`, `jiti`, `async_hooks`, CommonJS `require`, or other Node-only dependencies in the Worker bundle;
- a bundle that deploys to a standard Cloudflare Worker without `nodejs_compat`.

Then choose the smallest maintenance path:

1. **Upstream covers the contract:** migrate consumers to the official v1 API, run the compatibility and production rollout sections below, then retire the forked entry.
2. **Upstream is mostly sufficient:** keep a small adapter for DINO-specific error/hint shapes, but use upstream snapshot and diff APIs. Do not retain copied internals unnecessarily.
3. **Upstream remains Node-only or interactive:** port this patch onto the v1 tag. Reapply it by responsibility rather than blindly merging the old branch.

Relevant upstream discussions should be rechecked because their state can change:

- [Worker-compatible schema tooling issue #5676](https://github.com/drizzle-team/drizzle-orm/issues/5676)
- [Programmatic migration API issue #6053](https://github.com/drizzle-team/drizzle-orm/issues/6053)
- [Worker/API pull request #6097](https://github.com/drizzle-team/drizzle-orm/pull/6097)
- [API-related pull request #5966](https://github.com/drizzle-team/drizzle-orm/pull/5966)

## Prepare an upgrade branch

Record the exact current state before editing:

```sh
git status --short
git rev-parse HEAD
git describe --tags --always
corepack pnpm --dir drizzle-kit exec drizzle-kit --version
corepack pnpm why drizzle-kit
corepack pnpm why drizzle-orm
```

Archive representative inputs and expected outputs as test fixtures:

- a new schema with tables, enums, indexes, foreign keys, and views;
- a rename requiring a hint;
- a create/drop choice requiring a hint;
- the last real snapshot for several representative workspaces;
- accepted hints and the expected SQL for each transition.

Fetch upstream and start from the v1 tag. Replace `<v1-tag>` with the verified release tag:

```sh
git fetch upstream --tags
git switch --create codex/drizzle-v1-worker <v1-tag>
```

If the fork is still required, use commits `83f3ba7f` and `7442a1ec` as a change inventory, not as an assumption that a clean cherry-pick is correct:

```sh
git show --stat 83f3ba7f
git show --stat 7442a1ec
git diff <v1-tag>...codex/cloudflare-worker-api -- drizzle-kit
```

Port in this order:

1. Separate pure schema conversion from the Node file loader if upstream has not already done so.
2. Add the Worker export and its type declarations.
3. Reuse upstream DDL and diff internals; do not copy a second diff engine.
4. Port deterministic hints and structured errors only where upstream lacks equivalent behavior.
5. Restore bundle safety validation, tests, documentation, export-map entries, and package contents.

Review every conflict in snapshot types, serializer code, DDL statements, and rename resolvers. A compiling cherry-pick does not prove semantic compatibility.

## Prove snapshot and SQL compatibility

For each fixture and representative real schema, generate:

- the old snapshot with the currently deployed Worker package;
- a v1 snapshot from the same schema;
- old-to-new SQL using the v1 implementation;
- new-to-new SQL using the v1 implementation.

Compare snapshots structurally. Normalize only known nondeterministic identifiers used by tests; do not normalize away snapshot version, dialect, entity names, column types, defaults, constraints, ordering that affects output, or DDL statement differences.

The upgrade passes only when:

- an unchanged schema emits no migration SQL;
- every intentional change emits the expected SQL in the expected order;
- the old production snapshot is accepted or is converted explicitly;
- rename/create ambiguity still produces a structured missing-hints result;
- replaying accepted hints is deterministic;
- destructive SQL remains visible to the caller's policy gate.

Never replace a production snapshot merely because v1 can generate a new baseline. If the snapshot format is incompatible, implement and test an explicit converter or create a new baseline only after independently verifying the live database and recording why history can be reset. Preserve the previous snapshot until the new migration has completed and been audited.

## Validate the fork/package

Build `drizzle-orm` first because Drizzle Kit consumes its local artifacts:

```sh
corepack pnpm --dir drizzle-orm run build
corepack pnpm --dir drizzle-kit run build
```

Run the focused Worker and shared payload tests:

```sh
corepack pnpm --dir drizzle-kit exec vitest run \
  tests/ext/api-postgres-worker.test.ts \
  tests/ext/worker-hints.test.ts \
  tests/other/payload-generate.test.ts
```

Confirm the normal CLI paths still work:

```sh
corepack pnpm --dir drizzle-kit exec vitest run \
  tests/other/cli-json.test.ts \
  tests/other/push-non-tty-guard.test.ts
```

Then run static checks and create the actual release artifact:

```sh
corepack pnpm --dir drizzle-kit exec tsc -p tsconfig.json --noEmit --pretty false
corepack pnpm run lint:check
corepack pnpm run format:check
corepack pnpm --dir drizzle-kit run pack
tar -tf drizzle-kit/package.tgz | sort
```

The build must reject Node-only imports in the Worker entry. Inspect the tarball rather than relying on the source tree: it must contain the Worker JavaScript, declarations, export map, `WORKER_API.md`, and this runbook.

Install the tarball in an empty temporary consumer alongside the official CLI. Verify all four operations:

1. import the official Node API;
2. run the official `drizzle-kit` CLI;
3. import the Worker package through its alias and generate a snapshot/diff;
4. typecheck the consumer.

Finally run `wrangler deploy --dry-run` and a local Wrangler request without `nodejs_compat`. Test both a no-op schema and a rename that uses an explicit hint. Record raw/gzip bundle size, build time, request result, package versions, and commit SHA.

## Package both APIs without collisions

Do not publish the fork using the unscoped upstream name `drizzle-kit`. Stage the release with a private/scoped package name and an explicit prerelease version, for example `@dino/drizzle-kit@1.0.0-worker.0`. Changing the source repository's package name is not required for development, but the `dist/package.json` in the artifact being published must have the scoped name and intended version.

A consumer can keep both packages installed:

```json
{
  "devDependencies": {
    "drizzle-kit": "1.0.0",
    "drizzle-kit-worker": "npm:@dino/drizzle-kit@1.0.0-worker.0"
  }
}
```

Use `drizzle-kit` for config files, `generate`, `push`, Studio, and other normal Node CLI work. Import only `drizzle-kit-worker/api-postgres-worker` from the Cloudflare Worker. Keep `drizzle-orm`, official Kit, and the Worker fork on a tested compatibility matrix; never use floating ranges for the fork.

Before publishing, test `npm pack` and the packed consumer again after rewriting the package name/version. A successful local build of the unscoped package is not proof that the scoped release artifact is correct.

For the temporary GitHub-pinned distribution used by DINO, run `corepack pnpm --dir drizzle-kit run pack:worker`. This builds `drizzle-kit/drizzle-kit-worker.tgz`, containing only the Worker JavaScript, declarations, README, and scoped package metadata. Commit the archive and consume it through an immutable raw URL containing that commit SHA; never depend on a moving branch URL in production.

## Production rollout

1. Publish a prerelease package; do not replace the stable version first.
2. In DINO, update the Worker alias and its compatible `drizzle-orm` version together while leaving official `drizzle-kit` available for the CLI.
3. Dual-run the old and new generators on current workspace schemas without applying the new result. Compare normalized snapshots, missing-hint responses, and SQL.
4. Run a canary against a disposable workspace and database. Exercise no-op, additive, rename, and policy-rejected destructive changes.
5. Confirm migration execution is serialized per workspace and snapshots/hints are persisted only after successful application.
6. Enable the new generator behind a versioned configuration or feature flag for a small cohort, monitor it, then expand gradually.
7. Record the artifact version, Git SHA, upstream tag, compatible ORM/Kit versions, validation evidence, and rollout time.

The generator does not authorize or apply SQL. Keep review/policy checks, transaction strategy, database execution, publication, and locking in the owning DINO service.

## Rollback rules

Before any generated SQL is applied, rollback is a dependency/configuration change: restore the old Worker package and old snapshot, then regenerate.

After SQL has been applied, downgrading the package is **not** a database rollback. Use a separately reviewed forward repair, a previously validated down migration, or a database restore. Keep the applied SQL, before/after snapshots, hints, executor result, and package versions as one audit record.

Do not let two versions write the next snapshot for the same workspace concurrently. During rollout, assign one authoritative generator per workspace even if both versions run in comparison mode.

## Release acceptance checklist

- [ ] Exact upstream tag, fork SHA, package versions, and lockfile recorded.
- [ ] Upstream Worker/API support evaluated and fork code removed where redundant.
- [ ] Old and new snapshots compared on fixtures and real representative schemas.
- [ ] Unchanged schemas produce no SQL.
- [ ] Rename/create hints and malformed external hints behave deterministically.
- [ ] Focused Worker, shared payload, normal CLI, typecheck, lint, and build checks pass.
- [ ] Packed artifact contains the documented Worker entry and declarations.
- [ ] Official CLI and aliased Worker package coexist in a clean consumer.
- [ ] Wrangler dry-run and local request pass without `nodejs_compat`.
- [ ] Destructive SQL policy, per-workspace serialization, audit persistence, and failure behavior are exercised.
- [ ] Disposable canary passes before any production workspace is enabled.
- [ ] Rollback owner and database recovery procedure are recorded.

If any item is skipped, record the reason and the remaining production risk in the release notes.
