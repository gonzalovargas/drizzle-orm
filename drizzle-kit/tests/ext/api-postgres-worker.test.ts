import { integer, pgSchema, pgTable, serial, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import {
	generateDrizzleJson as generateNodeSnapshot,
	generateMigration as generateNodeMigration,
} from '../../src/ext/api-postgres';
import {
	generateDrizzleJson as generateWorkerSnapshot,
	generateMigration as generateWorkerMigration,
	InvalidWorkerHintsError,
	MissingHintsError,
} from '../../src/ext/api-postgres-worker';

const withoutId = <T extends { id: string }>(snapshot: T) => {
	const { id: _, ...rest } = snapshot;
	return rest;
};

describe('Cloudflare Worker Postgres API', () => {
	test('generates the same representative snapshot as the Node API', async () => {
		const crm = pgSchema('crm');
		const customerState = crm.enum('customer_state', ['active', 'inactive']);
		const customers = crm.table('customers', {
			id: serial('id').primaryKey(),
			email: text('email').notNull(),
			state: customerState('state').notNull(),
		}, (table) => [uniqueIndex('customers_email_unique').on(table.email)]);
		const orders = crm.table('orders', {
			id: serial('id').primaryKey(),
			customerId: integer('customer_id').notNull().references(() => customers.id),
		});
		const existingView = crm.view('legacy_customers', { id: integer('id') }).existing();
		const ignoredPublicTable = pgTable('ignored_public_table', { id: integer('id') });
		const schema = { crm, customerState, customers, orders, existingView, ignoredPublicTable };

		const [nodeSnapshot, workerSnapshot] = await Promise.all([
			generateNodeSnapshot(schema, undefined, ['crm']),
			generateWorkerSnapshot(schema, undefined, ['crm']),
		]);

		expect(withoutId(workerSnapshot)).toEqual(withoutId(nodeSnapshot));
		expect(workerSnapshot.ddl.some((entity) => entity.name === 'ignored_public_table')).toBe(false);
		expect(workerSnapshot.ddl.some((entity) => entity.name === 'legacy_customers')).toBe(false);
	});

	test('generates the same unambiguous SQL as the Node API', async () => {
		const before = { users: pgTable('users', { id: serial('id').primaryKey() }) };
		const after = { users: pgTable('users', { id: serial('id').primaryKey(), email: text('email') }) };
		const [nodeBefore, nodeAfter, workerBefore, workerAfter] = await Promise.all([
			generateNodeSnapshot(before),
			generateNodeSnapshot(after),
			generateWorkerSnapshot(before),
			generateWorkerSnapshot(after),
		]);

		expect(await generateWorkerMigration(workerBefore, workerAfter)).toEqual(
			await generateNodeMigration(nodeBefore, nodeAfter),
		);
	});

	test('requires an explicit decision and produces deterministic rename or create SQL', async () => {
		const before = await generateWorkerSnapshot({
			users: pgTable('users', { id: serial('id').primaryKey(), fullName: text('full_name') }),
		});
		const after = await generateWorkerSnapshot({
			users: pgTable('users', { id: serial('id').primaryKey(), name: text('name') }),
		}, before.id);

		const unresolved = await generateWorkerMigration(before, after).catch((error) => error);
		expect(unresolved).toBeInstanceOf(MissingHintsError);
		expect((unresolved as MissingHintsError).code).toBe('missing_hints');
		expect((unresolved as MissingHintsError).missingHints).toEqual([{
			type: 'rename_or_create',
			kind: 'column',
			entity: ['public', 'users', 'name'],
		}]);

		await expect(generateWorkerMigration(before, after, {
			hints: [{
				type: 'rename',
				kind: 'column',
				from: ['public', 'users', 'full_name'],
				to: ['public', 'users', 'name'],
			}],
		})).resolves.toEqual(['ALTER TABLE "users" RENAME COLUMN "full_name" TO "name";']);

		await expect(generateWorkerMigration(before, after, {
			hints: [{
				type: 'create',
				kind: 'column',
				entity: ['public', 'users', 'name'],
			}],
		})).resolves.toEqual([
			'ALTER TABLE "users" ADD COLUMN "name" text;',
			'ALTER TABLE "users" DROP COLUMN "full_name";',
		]);
	});

	test('rejects malformed runtime hints before diffing', async () => {
		const snapshot = await generateWorkerSnapshot({});

		const error = await generateWorkerMigration(snapshot, snapshot, {
			hints: [{ type: 'rename', kind: 'column', from: ['users'], to: ['name'] }] as never,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(InvalidWorkerHintsError);
		expect((error as InvalidWorkerHintsError).code).toBe('invalid_hints');
		expect((error as Error).message).toContain('tuple of 3 strings');
	});
});
