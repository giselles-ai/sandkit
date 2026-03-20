export default {
  dialect: "sqlite",
  schema: "./generated/sandkit-schema.generated.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "file:./smoke-drizzle-workspaces.sqlite",
  },
  verbose: true,
} as const;
