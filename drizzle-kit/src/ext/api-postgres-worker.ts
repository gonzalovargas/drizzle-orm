import {
	getMaterializedViewConfig,
	getViewConfig,
	type PgMaterializedView,
	type PgSchema,
	type PgView,
} from 'drizzle-orm/pg-core';
import { createDDL, interimToDDL } from '../dialects/postgres/ddl';
import type {
	CheckConstraint,
	Column,
	Enum,
	ForeignKey,
	Index,
	Policy,
	PostgresEntities,
	PrimaryKey,
	Privilege,
	Role,
	Schema as DdlSchema,
	Sequence,
	UniqueConstraint,
	View,
} from '../dialects/postgres/ddl';
import { ddlDiff } from '../dialects/postgres/diff';
import { fromDrizzleSchema, fromExports } from '../dialects/postgres/drizzle';
import type { PostgresSnapshot } from '../dialects/postgres/snapshot';
import type { EntityFilter, Schema, Table } from '../dialects/pull-utils';
import { createHintsResolver, type Hint, MissingHintsError, WorkerHintsHandler } from './worker-hints';

export { InvalidWorkerHintsError, MissingHintsError } from './worker-hints';
export type { Hint, MissingHint } from './worker-hints';

const originUUID = '00000000-0000-0000-0000-000000000000';

const getExistingEntities = (
	schemas: PgSchema[],
	views: PgView[],
	materializedViews: PgMaterializedView[],
): (Schema | Table)[] => [
	...schemas.filter((schema) => schema.isExisting).map<Schema>((schema) => ({
		name: schema.schemaName,
		type: 'schema',
	})),
	...views.map(getViewConfig).filter((view) => view.isExisting).map<Table>((view) => ({
		name: view.name,
		schema: view.schema ?? 'public',
		type: 'table',
	})),
	...materializedViews.map(getMaterializedViewConfig).filter((view) => view.isExisting).map<Table>((view) => ({
		name: view.name,
		schema: view.schema ?? 'public',
		type: 'table',
	})),
];

const createEntityFilter = (
	schemaFilters: string[],
	existing: (Schema | Table)[],
): EntityFilter => {
	const existingSchemas = new Set(
		existing.filter((entity): entity is Schema => entity.type === 'schema').map((entity) => entity.name),
	);
	const existingTables = new Set(
		existing.filter((entity): entity is Table => entity.type === 'table').map((entity) =>
			`${entity.schema || 'public'}\0${entity.name}`
		),
	);
	const includedSchemas = new Set(schemaFilters);

	return (entity) => {
		if (entity.type === 'schema') {
			return !existingSchemas.has(entity.name)
				&& (includedSchemas.size === 0 || includedSchemas.has(entity.name));
		}
		if (entity.type === 'role') return true;

		const schema = entity.schema || 'public';
		return !existingTables.has(`${schema}\0${entity.name}`)
			&& (includedSchemas.size === 0 || includedSchemas.has(schema));
	};
};

const formatIssues = (issues: unknown[]) =>
	issues.map((issue) => {
		try {
			return JSON.stringify(issue);
		} catch {
			return String(issue);
		}
	}).join('\n');

export const generateDrizzleJson = async (
	imports: Record<string, unknown>,
	prevId?: string,
	schemaFilters: string[] = [],
): Promise<PostgresSnapshot> => {
	const prepared = fromExports(imports);
	const existing = getExistingEntities(prepared.schemas, prepared.views, prepared.matViews);
	const filter = createEntityFilter(schemaFilters, existing);
	const { schema: interim, errors, warnings } = fromDrizzleSchema(prepared, filter);
	const { ddl, errors: ddlErrors } = interimToDDL(interim);

	if (warnings.length > 0) console.warn(formatIssues(warnings));
	if (errors.length > 0 || ddlErrors.length > 0) {
		throw new Error(`Invalid Postgres schema:\n${formatIssues([...errors, ...ddlErrors])}`);
	}

	return {
		ddl: ddl.entities.list(),
		dialect: 'postgres',
		id: (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID(),
		prevIds: prevId ? [prevId] : [originUUID],
		renames: [],
		version: '8',
	};
};

export const generateMigration = async (
	prev: PostgresSnapshot,
	cur: PostgresSnapshot,
	options?: { hints?: Hint[] },
) => {
	const from = createDDL();
	const to = createDDL();

	for (const entity of prev.ddl) from.entities.push(entity);
	for (const entity of cur.ddl) to.entities.push(entity);

	const hints = new WorkerHintsHandler(options?.hints);
	const { sqlStatements } = await ddlDiff(
		from,
		to,
		createHintsResolver<DdlSchema>('schema', hints),
		createHintsResolver<Enum>('enum', hints),
		createHintsResolver<Sequence>('sequence', hints),
		createHintsResolver<Policy>('policy', hints),
		createHintsResolver<Role>('role', hints),
		createHintsResolver<Privilege>('privilege', hints),
		createHintsResolver<PostgresEntities['tables']>('table', hints),
		createHintsResolver<Column>('column', hints),
		createHintsResolver<View>('view', hints),
		createHintsResolver<UniqueConstraint>('unique', hints),
		createHintsResolver<Index>('index', hints),
		createHintsResolver<CheckConstraint>('check', hints),
		createHintsResolver<PrimaryKey>('primary_key', hints),
		createHintsResolver<ForeignKey>('foreign key', hints),
		'default',
	);
	if (hints.missingHints.length > 0) throw new MissingHintsError(hints.missingHints);
	return sqlStatements;
};
