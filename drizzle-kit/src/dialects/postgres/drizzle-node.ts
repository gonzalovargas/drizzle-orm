import type { Relations } from 'drizzle-orm/_relations';
import type {
	AnyPgTable,
	PgEnum,
	PgMaterializedView,
	PgPolicy,
	PgRole,
	PgSchema,
	PgSequence,
	PgView,
} from 'drizzle-orm/pg-core';
import { loadModule } from '../../utils/utils-node';
import { fromExports, type PreparedPostgresSchema } from './drizzle';

export const prepareFromSchemaFiles = async (imports: string[]) => {
	const tables: AnyPgTable[] = [];
	const enums: PgEnum<any>[] = [];
	const schemas: PgSchema[] = [];
	const sequences: PgSequence[] = [];
	const views: PgView[] = [];
	const roles: PgRole[] = [];
	const policies: PgPolicy[] = [];
	const matViews: PgMaterializedView[] = [];
	const relations: Relations[] = [];

	for (let i = 0; i < imports.length; i++) {
		const it = imports[i];

		const i0: Record<string, unknown> = await loadModule(it);
		const prepared = fromExports(i0);

		tables.push(...prepared.tables);
		enums.push(...prepared.enums);
		schemas.push(...prepared.schemas);
		sequences.push(...prepared.sequences);
		views.push(...prepared.views);
		matViews.push(...prepared.matViews);
		roles.push(...prepared.roles);
		policies.push(...prepared.policies);
		relations.push(...prepared.relations);
	}

	return {
		tables,
		enums,
		schemas,
		sequences,
		views,
		matViews,
		roles,
		policies,
		relations,
	};
};

// Decouples the schema's origin (compiled `.ts` files vs. a supplied prebuilt schema) from its consumers.
export interface SchemaSource {
	load(): Promise<PreparedPostgresSchema>;
}

export const SchemaSource = {
	fromFilenames(filenames: string[]): SchemaSource {
		return { load: () => prepareFromSchemaFiles(filenames) };
	},
	fromSchema(schema: PreparedPostgresSchema): SchemaSource {
		return { load: async () => schema };
	},
};
