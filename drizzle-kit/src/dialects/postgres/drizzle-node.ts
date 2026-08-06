import { loadModule } from '../../utils/utils-node';
import { fromExports, type PreparedPostgresSchema } from './drizzle';

export const prepareFromSchemaFiles = async (imports: string[]): Promise<PreparedPostgresSchema> => {
	const result: PreparedPostgresSchema = {
		tables: [],
		enums: [],
		schemas: [],
		sequences: [],
		views: [],
		matViews: [],
		roles: [],
		policies: [],
		relations: [],
	};

	for (const file of imports) {
		const schema = fromExports(await loadModule(file));
		result.tables.push(...schema.tables);
		result.enums.push(...schema.enums);
		result.schemas.push(...schema.schemas);
		result.sequences.push(...schema.sequences);
		result.views.push(...schema.views);
		result.matViews.push(...schema.matViews);
		result.roles.push(...schema.roles);
		result.policies.push(...schema.policies);
		result.relations.push(...schema.relations);
	}

	return result;
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
