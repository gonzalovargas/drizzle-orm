# Postgres schema diff in Cloudflare Workers

`drizzle-kit/api-postgres-worker` exposes the schema-to-snapshot and snapshot-to-SQL portions of Drizzle Kit without loading the Node.js CLI, filesystem, prompts, or module loader. It is intended for applications that already have Drizzle schema exports in memory, such as a code builder running in a Cloudflare Worker or Durable Object.

## Runtime contract

- Runtime: standard Cloudflare Workers or another Web-standard ESM runtime.
- Compatibility flags: `nodejs_compat` is not required.
- Database access: none. The API compares in-memory snapshots and returns SQL; it does not connect to Postgres or apply migrations.
- Schema loading: pass imported schema exports. File paths and TypeScript module loading remain Node-only features of the regular CLI.
- Randomness: `generateDrizzleJson` uses `globalThis.crypto.randomUUID()` for snapshot IDs.
- Errors: invalid schemas and unresolved ambiguities throw. The API never calls `process.exit()` and never prompts.
- Versioning: snapshots use Drizzle Kit's internal Postgres snapshot format. Keep `drizzle-orm`, the regular `drizzle-kit`, and this Worker build on the same release or commit family.

The normal entry points are unchanged:

```ts
import { generateMigration } from 'drizzle-kit/api-postgres'; // Node.js
import { generateMigration as generateMigrationInWorker } from 'drizzle-kit/api-postgres-worker';
```

For applications that must keep the official CLI pinned independently, publish this fork under a scoped package and install it through an alias:

```json
{
  "devDependencies": {
    "drizzle-kit": "1.0.0-rc.4"
  },
  "dependencies": {
    "drizzle-kit-worker": "npm:@dino/drizzle-kit@1.0.0-rc.4-worker.1"
  }
}
```

Then import `drizzle-kit-worker/api-postgres-worker` in Worker code while continuing to run the official `drizzle-kit` binary.

## Generate a snapshot

```ts
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { generateDrizzleJson } from 'drizzle-kit/api-postgres-worker';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});

const snapshot = await generateDrizzleJson({ users });
```

The first argument has the same shape as a schema module's exports. The optional second argument is the previous snapshot ID. The optional third argument limits output to named Postgres schemas.

## Generate SQL and resolve ambiguity

```ts
import {
  generateMigration,
  MissingHintsError,
  type Hint,
} from 'drizzle-kit/api-postgres-worker';

try {
  const statements = await generateMigration(previousSnapshot, currentSnapshot);
  // Persist or review statements before applying them.
} catch (error) {
  if (error instanceof MissingHintsError) {
    return Response.json({
      status: 'missing_hints',
      unresolved: error.missingHints,
    }, { status: 409 });
  }
  throw error;
}
```

When a created entity could be a rename of a deleted entity, retry with an explicit hint:

```ts
const hints: Hint[] = [{
  type: 'rename',
  kind: 'column',
  from: ['public', 'users', 'full_name'],
  to: ['public', 'users', 'name'],
}];

const statements = await generateMigration(previousSnapshot, currentSnapshot, { hints });
```

Use a `create` hint when the change is intentionally an addition plus a deletion:

```ts
const hints: Hint[] = [{
  type: 'create',
  kind: 'column',
  entity: ['public', 'users', 'name'],
}];
```

Never silently guess a rename in production. A wrong rename preserves the wrong data; a wrong create decision can emit a destructive drop.

Hints are validated at runtime as well as typed. Malformed types, unsupported kinds, or tuple lengths throw `InvalidWorkerHintsError` with `code: "invalid_hints"` before the diff runs. This matters when hints come from JSON or an agent rather than directly from TypeScript.

## What remains shared with Drizzle Kit

The Worker entry reuses the existing Postgres schema conversion, DDL representation, diff engine, statement preparation, and SQL generation. Worker-specific code only replaces the Node/CLI boundaries:

- extracting existing entities and applying schema filters;
- constructing snapshots with Web Crypto;
- resolving rename-or-create conflicts from supplied hints;
- reporting missing hints as structured errors.

`prepareFromSchemaFiles` and `SchemaSource` live in `dialects/postgres/drizzle-node.ts` so importing the pure schema conversion code cannot pull `fs`, `jiti`, prompts, or CLI context into a Worker bundle.

## Production safety checklist

1. Pin compatible `drizzle-orm` and Worker-package versions; do not float either dependency.
2. Store the previous snapshot durably and pass its `id` when generating the next snapshot.
3. Treat `MissingHintsError` as a required decision, not as a retryable infrastructure failure.
4. Review or policy-check destructive SQL before applying it. This API generates SQL but does not provide authorization, locking, transactions, or rollback.
5. Serialize publication per workspace so two builders cannot migrate from the same previous snapshot concurrently.
6. Persist the accepted hints with the migration for auditability and deterministic regeneration.
7. Run the package build before publishing. It validates that the Worker entry contains no Node built-ins, CommonJS `require`, `process.exit`, `jiti`, or `AsyncLocalStorage`.
8. Run a Wrangler dry-run and a local Worker request against the packed artifact, without `nodejs_compat`.

## Deliberate limitations

- Postgres only.
- In-memory schema exports only; no file path loading.
- No database introspection, `push`, Studio, CLI output formatting, or interactive prompts.
- No migration application. The caller owns review, transaction strategy, execution, and publication.
- The snapshot and DDL types are internal Drizzle Kit contracts and may require a rebase when upstream changes them.

See [WORKER_MAINTENANCE.md](./WORKER_MAINTENANCE.md) before upgrading Drizzle, rebasing this fork, publishing the scoped Worker package, or rolling it out to production.
