import { describe, expect, test } from 'vitest';
import { createHintsResolver, InvalidWorkerHintsError, WorkerHintsHandler } from '../../src/ext/worker-hints';

const oldColumn = { schema: 'public', table: 'users', name: 'full_name' };
const newColumn = { schema: 'public', table: 'users', name: 'name' };

describe('Cloudflare Worker migration hints', () => {
	test('records an unresolved rename-or-create ambiguity', async () => {
		const hints = new WorkerHintsHandler();
		const result = await createHintsResolver<typeof oldColumn>('column', hints)({
			created: [newColumn],
			deleted: [oldColumn],
		});

		expect(result).toEqual({ created: [newColumn], deleted: [oldColumn], renamedOrMoved: [] });
		expect(hints.missingHints).toEqual([{
			type: 'rename_or_create',
			kind: 'column',
			entity: ['public', 'users', 'name'],
		}]);
	});

	test('resolves an explicit rename without prompting', async () => {
		const hints = new WorkerHintsHandler([{
			type: 'rename',
			kind: 'column',
			from: ['public', 'users', 'full_name'],
			to: ['public', 'users', 'name'],
		}]);

		await expect(
			createHintsResolver<typeof oldColumn>('column', hints)({
				created: [newColumn],
				deleted: [oldColumn],
			}),
		).resolves.toEqual({
			created: [],
			deleted: [],
			renamedOrMoved: [{ from: oldColumn, to: newColumn }],
		});
		expect(hints.missingHints).toEqual([]);
	});

	test('resolves an explicit create and leaves the deletion intact', async () => {
		const hints = new WorkerHintsHandler([{
			type: 'create',
			kind: 'column',
			entity: ['public', 'users', 'name'],
		}]);

		await expect(
			createHintsResolver<typeof oldColumn>('column', hints)({
				created: [newColumn],
				deleted: [oldColumn],
			}),
		).resolves.toEqual({
			created: [newColumn],
			deleted: [oldColumn],
			renamedOrMoved: [],
		});
		expect(hints.missingHints).toEqual([]);
	});

	test('rejects unsupported hint kinds and non-string tuple members', () => {
		expect(() => new WorkerHintsHandler([{ type: 'create', kind: 'unknown', entity: ['x'] }]))
			.toThrow(InvalidWorkerHintsError);
		expect(() =>
			new WorkerHintsHandler([{
				type: 'rename',
				kind: 'table',
				from: ['public', 42],
				to: ['public', 'users'],
			}])
		).toThrow('tuple of 2 strings');
	});
});
