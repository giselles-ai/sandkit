export default {
  dialect: "sqlite",
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "file:./data/merge-readiness.sqlite",
  },
  verbose: true,
} as const;
