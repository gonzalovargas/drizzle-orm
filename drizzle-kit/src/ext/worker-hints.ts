import type { Resolver } from '../dialects/common';
import type { Hint, MissingHint, RenameCreateHintKind } from '../cli/hints';

export type { Hint, MissingHint } from '../cli/hints';

type PromptEntityBase = { name: string; schema?: string; table?: string };
type RenameHint = Extract<Hint, { type: 'rename' }>;
type CreateHint = Extract<Hint, { type: 'create' }>;

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
		case 'privilege': {
			const privilege = entity as PromptEntityBase & {
				grantor: string;
				grantee: string;
				type: string;
			};
			if (!entity.table) throw new Error('Expected privilege resolver entity to include a table name');
			return [privilege.grantor, privilege.grantee, entity.schema ?? 'public', entity.table, privilege.type];
		}
		default:
			if (!entity.table) throw new Error(`Expected ${kind} resolver entity to include a table name`);
			return [entity.schema ?? 'public', entity.table, entity.name];
	}
};

export class MissingHintsError extends Error {
	readonly code = 'missing_hints' as const;
	readonly missingHints: readonly MissingHint[];

	constructor(missingHints: readonly MissingHint[]) {
		super(`Ambiguous schema changes require hints: ${missingHints.map((hint) => `${hint.kind} ${hint.entity.join('.')}`).join(', ')}`);
		this.name = 'MissingHintsError';
		this.missingHints = missingHints;
	}
}

export class WorkerHintsHandler {
	readonly missingHints: MissingHint[] = [];

	constructor(private readonly hints: readonly Hint[] = []) {}

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
): Resolver<T> => async ({ created, deleted }) => {
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
