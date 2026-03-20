import type { SandkitSchemaModel, SandkitDialect } from "./model";

const typeMap = {
  sqlite: {
    text: "text",
    integer: "integer",
    boolean: "integer({ mode: 'boolean' })",
    json: "text({ mode: 'json' })",
    timestamp: "integer({ mode: 'timestamp_ms' })",
  },
  postgresql: {
    text: "text",
    integer: "integer",
    boolean: "boolean",
    json: "jsonb",
    timestamp: "timestamp",
  },
  mysql: {
    text: "text",
    integer: "int",
    boolean: "boolean",
    json: "json",
    timestamp: "timestamp",
  },
} as const;

const tableFactoryByDialect = {
  sqlite: "sqliteTable",
  postgresql: "pgTable",
  mysql: "mysqlTable",
} as const;

export function renderTextSchema(model: SandkitSchemaModel): string {
  const exportNameByTable = new Map(
    model.tables.map((table) => [table.name, table.exportName ?? table.name]),
  );

  const entries = model.tables
    .map((table) => {
      const builder = tableFactoryByDialect[model.dialect];
      const tableExpr =
        model.dialect === "sqlite"
          ? `${builder}("${table.name}", {`
          : `${builder}("${table.name}", {\n`;

      const row = table.columns
        .map((column) => {
          const mappedType = typeMap[model.dialect][column.type];
          const defaultValue = column.defaultValue === null ? "default null" : "";
          const required = column.nullable === true ? "" : ".notNull()";
          const unique = column.unique ? ".unique()" : "";
          const primary = column.primaryKey ? ".primaryKey()" : "";
          const ref = column.references
            ? `.references(() => ${
                exportNameByTable.get(column.references.table) ?? column.references.table
              }.${column.references.field})`
            : "";
          return `${column.name}: ${mappedType}("${column.name}")${required}${defaultValue}${unique}${primary}${ref}`;
        })
        .join(",\n");

      const rows = row ? `\n  ${row}\n` : "";
      const exportName = table.exportName ?? table.name;
      return `export const ${exportName} = ${tableExpr}${rows});`;
    })
    .join("\n\n");

  const imports = {
    sqlite: 'import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";',
    postgresql: 'import { pgTable } from "drizzle-orm/pg-core";',
    mysql: 'import { mysqlTable } from "drizzle-orm/mysql-core";',
  } as const;

  const maybeExtras = model.dialect === "sqlite" ? "" : model.dialect === "postgresql" ? "" : "";

  return `// This file is generated from Sandkit schema model.\n// Provider: ${model.dialect}\n// Version: ${1}\n\n${imports[model.dialect]}\n\n${entries}\n\nexport const sandkitSchema = {\n${model.tables
    .map((table) => {
      const exportName = table.exportName ?? table.name;
      return `  ${exportName},`;
    })
    .join("\n")}\n};\n${maybeExtras}\n`;
}

export function createGeneratePayload(dialect: SandkitDialect, model: SandkitSchemaModel) {
  return {
    dialect,
    generatedAt: new Date().toISOString(),
    summary: {
      tableCount: model.tables.length,
      tableNames: model.tables.map((table) => table.name),
    },
    schemaText: renderTextSchema(model),
  };
}
