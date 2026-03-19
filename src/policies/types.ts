export interface NetworkPolicyRecord {
  /**
   * Target hostname to match.
   * The hostname comparison is case-insensitive.
   */
  host: string;
  /**
   * Allow direct host match and all subdomains for this host.
   */
  includeSubdomains?: boolean;
  /**
   * Optional pathname prefix to match. Use this when a policy only allows
   * a specific endpoint family.
   */
  pathPrefix?: string;
  /**
   * Optional port allowlist.
   */
  ports?: readonly number[];
}

export interface NetworkPolicy {
  id: string;
  name: string;
  description?: string;
  records: readonly NetworkPolicyRecord[];
}

export interface NetworkPolicyDecision {
  allowed: boolean;
  matchedPolicyId?: string;
  matchedPolicyName?: string;
  matchedRecord?: NetworkPolicyRecord;
  reason: string;
}
