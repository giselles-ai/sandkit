export default {
  dialect: "sqlite",
  schema: "./db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "file:./data/openclaw.sqlite",
  },
  verbose: true,
} as const;
