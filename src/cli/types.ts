export type SandkitCliCommand = "generate";

export interface SandkitGenerateArgs {
  provider: "sqlite" | "postgresql" | "mysql";
  out?: string;
  stdout: boolean;
}

export interface SandkitCliOptions {
  command: SandkitCliCommand;
  provider: SandkitGenerateArgs["provider"];
  out?: SandkitGenerateArgs["out"];
  stdout: SandkitGenerateArgs["stdout"];
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
