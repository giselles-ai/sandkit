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

export interface WorkspaceUserDefinedPolicy {
  readonly mode: "allow-services";
  readonly services: readonly PolicyServiceDescriptor[];
}

/**
 * Durable workspace firewall policy.
 *
 * Sandkit models the same three policy shapes exposed by Vercel Sandbox firewall:
 * - allow-all
 * - deny-all
 * - user-defined
 *
 * User-defined policies are currently expressed as allowed service descriptors.
 * Reference: https://vercel.com/docs/vercel-sandbox/concepts/firewall
 */
export type WorkspacePolicy =
  | WorkspaceAllowAllPolicy
  | WorkspaceDenyAllPolicy
  | WorkspaceUserDefinedPolicy;

export interface WorkspacePolicyDecision {
  readonly allowed: boolean;
  readonly matchedServiceId?: string;
  readonly matchedServiceName?: string;
  readonly matchedDomain?: string;
  readonly reason: string;
}
