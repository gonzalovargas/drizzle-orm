import type { ConfirmEntityKind, Hint, MissingHint, RenameCreateHintKind } from '../cli/hints';
import type { Resolver } from '../dialects/common';

export type { Hint, MissingHint } from '../cli/hints';

type PromptEntityBase = { name: string; schema?: string; table?: string };
type RenameHint = Extract<Hint, { type: 'rename' }>;
type CreateHint = Extract<Hint, { type: 'create' }>;

const renameCreateTupleLengths: Record<RenameCreateHintKind, number> = {
	table: 2,
	column: 3,
	default: 3,
	schema: 1,
	enum: 2,
	sequence: 2,
	view: 2,
	policy: 3,
	role: 1,
	check: 3,
	index: 3,
	unique: 3,
	primary_key: 3,
	'foreign key': 3,
};

const confirmTupleLengths: Record<ConfirmEntityKind, number> = {
	table: 2,
	column: 3,
	schema: 1,
	view: 2,
	primary_key: 3,
	add_not_null: 3,
	add_unique: 3,
};

export class InvalidWorkerHintsError extends Error {
	readonly code = 'invalid_hints' as const;

	constructor(message: string) {
		super(message);
		this.name = 'InvalidWorkerHintsError';
	}
}

function assertTuple(value: unknown, length: number, path: string): asserts value is string[] {
	if (!Array.isArray(value) || value.length !== length || value.some((segment) => typeof segment !== 'string')) {
		throw new InvalidWorkerHintsError(`${path} must be a tuple of ${length} strings`);
	}
}

const parseWorkerHints = (value: unknown): readonly Hint[] => {
	if (!Array.isArray(value)) throw new InvalidWorkerHintsError('hints must be an array');

	for (const [index, candidate] of value.entries()) {
		if (!candidate || typeof candidate !== 'object') {
			throw new InvalidWorkerHintsError(`hints[${index}] must be an object`);
		}
		const hint = candidate as Record<string, unknown>;
		if (hint.type === 'rename' || hint.type === 'create') {
			if (typeof hint.kind !== 'string' || !(hint.kind in renameCreateTupleLengths)) {
				throw new InvalidWorkerHintsError(`hints[${index}].kind is not supported for ${hint.type}`);
			}
			const length = renameCreateTupleLengths[hint.kind as RenameCreateHintKind];
			if (hint.type === 'rename') {
				assertTuple(hint.from, length, `hints[${index}].from`);
				assertTuple(hint.to, length, `hints[${index}].to`);
			} else {
				assertTuple(hint.entity, length, `hints[${index}].entity`);
			}
			continue;
		}
		if (hint.type === 'confirm_data_loss') {
			if (typeof hint.kind !== 'string' || !(hint.kind in confirmTupleLengths)) {
				throw new InvalidWorkerHintsError(`hints[${index}].kind is not supported for confirm_data_loss`);
			}
			assertTuple(
				hint.entity,
				confirmTupleLengths[hint.kind as ConfirmEntityKind],
				`hints[${index}].entity`,
			);
			continue;
		}

		throw new InvalidWorkerHintsError(`hints[${index}].type is not supported`);
	}

	return value as Hint[];
};

const tuplesEqual = (left: readonly string[], right: readonly string[]) =>
	left.length === right.length && left.every((segment, index) => segment === right[index]);

const entityId = (kind: RenameCreateHintKind, entity: PromptEntityBase): readonly string[] => {
	switch (kind) {
		case 'schema':
		case 'role':
			return [entity.name];
		case 'table':
		case 'enum':
		case 'sequence':
		case 'view':
			return [entity.schema ?? 'public', entity.name];
		default:
			if (!entity.table) throw new Error(`Expected ${kind} resolver entity to include a table name`);
			return [entity.schema ?? 'public', entity.table, entity.name];
	}
};

export class MissingHintsError extends Error {
	readonly code = 'missing_hints' as const;
	readonly missingHints: readonly MissingHint[];

	constructor(missingHints: readonly MissingHint[]) {
		super(
			`Ambiguous schema changes require hints: ${
				missingHints.map((hint) => `${hint.kind} ${hint.entity.join('.')}`).join(', ')
			}`,
		);
		this.name = 'MissingHintsError';
		this.missingHints = missingHints;
	}
}

export class WorkerHintsHandler {
	readonly missingHints: MissingHint[] = [];
	private readonly hints: readonly Hint[];

	constructor(hints: unknown = []) {
		this.hints = parseWorkerHints(hints);
	}

	findRename(kind: RenameCreateHintKind, to: readonly string[]): RenameHint | undefined {
		return this.hints.find((hint): hint is RenameHint =>
			hint.type === 'rename' && hint.kind === kind && tuplesEqual(hint.to, to)
		);
	}

	findCreate(kind: RenameCreateHintKind, entity: readonly string[]): CreateHint | undefined {
		return this.hints.find((hint): hint is CreateHint =>
			hint.type === 'create' && hint.kind === kind && tuplesEqual(hint.entity, entity)
		);
	}

	pushMissing(kind: RenameCreateHintKind, entity: readonly string[]) {
		this.missingHints.push({ type: 'rename_or_create', kind, entity } as MissingHint);
	}
}

export const createHintsResolver = <T extends PromptEntityBase>(
	kind: RenameCreateHintKind,
	hints: WorkerHintsHandler,
): Resolver<T> =>
async ({ created, deleted }) => {
	if (created.length === 0 || deleted.length === 0) {
		return { created, deleted, renamedOrMoved: [] };
	}

	const result = {
		created: [] as T[],
		deleted: [] as T[],
		renamedOrMoved: [] as { from: T; to: T }[],
	};
	let leftDeleted = [...deleted];

	for (const target of created) {
		const targetId = entityId(kind, target);
		const renameHint = hints.findRename(kind, targetId);
		if (renameHint) {
			const sourceIndex = leftDeleted.findIndex((source) => tuplesEqual(entityId(kind, source), renameHint.from));
			if (sourceIndex === -1) {
				throw new Error(`Rename hint source ${renameHint.from.join('.')} does not match a deleted ${kind}`);
			}
			const [source] = leftDeleted.splice(sourceIndex, 1);
			result.renamedOrMoved.push({ from: source!, to: target });
			continue;
		}

		if (!hints.findCreate(kind, targetId)) hints.pushMissing(kind, targetId);
		result.created.push(target);
	}

	result.deleted.push(...leftDeleted);
	return result;
};
