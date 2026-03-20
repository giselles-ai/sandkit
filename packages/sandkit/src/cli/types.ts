export type SandkitCliCommand = "generate";

export type SandkitSupportedAdapter = "drizzle";
export type SandkitDialect = "sqlite" | "postgresql" | "mysql";

export interface SandkitGenerateArgs {
  provider?: SandkitDialect;
  adapter?: SandkitSupportedAdapter;
  out?: string;
  stdout: boolean;
}

export interface SandkitGenerateResolvedArgs {
  provider: SandkitDialect;
  adapter?: SandkitSupportedAdapter;
  out?: string;
  stdout: boolean;
}

export interface SandkitCliOptions {
  command: SandkitCliCommand;
  provider?: SandkitDialect;
  adapter?: SandkitSupportedAdapter;
  out?: string;
  stdout: boolean;
}

export interface SandkitGenerateResult {
  command: "generate";
  provider: "sqlite" | "postgresql" | "mysql";
  outputTarget: "stdout" | "file";
  outputFile: string | null;
  payload: {
    generatedAt: string;
    summary: {
      tableCount: number;
      tableNames: string[];
    };
    schemaText: string;
  };
}
