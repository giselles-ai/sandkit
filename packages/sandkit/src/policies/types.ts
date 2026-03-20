export interface PolicyServiceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly domains: readonly string[];
}

export interface WorkspaceAllowAllPolicy {
  readonly mode: "allow-all";
}

export interface WorkspaceDenyAllPolicy {
  readonly mode: "deny-all";
}

export interface WorkspaceAllowServicesPolicy {
  readonly mode: "allow-services";
  readonly services: readonly PolicyServiceDescriptor[];
}

export type WorkspacePolicy =
  | WorkspaceAllowAllPolicy
  | WorkspaceDenyAllPolicy
  | WorkspaceAllowServicesPolicy;

export interface WorkspacePolicyDecision {
  readonly allowed: boolean;
  readonly matchedServiceId?: string;
  readonly matchedServiceName?: string;
  readonly matchedDomain?: string;
  readonly reason: string;
}
