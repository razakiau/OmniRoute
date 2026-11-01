import type { CredentialLeaseSelectionContext } from "./exclusiveConnectionLeasePolicy";
import type { ConnectionRestrictionSource } from "./credentialSelectionDiagnostics.ts";

export interface CredentialSelectionOptions {
  /** Provenance of the effective allowlist; does not alter authorization. */
  connectionRestrictionSources?: readonly ConnectionRestrictionSource[];
  /** Exclude credential-specific transports that cannot serve caller tools. */
  requireToolCalling?: boolean;
  allowSuppressedConnections?: boolean;
  allowRateLimitedConnections?: boolean;
  bypassQuotaPolicy?: boolean;
  forcedConnectionId?: string | null;
  /** API-key-scoped ordered preference. Only ranks connections that survived eligibility gates. */
  preferredConnectionIds?: string[] | null;
  /** The pin was chosen by the operator for this request (x-omniroute-connection), not derived by a combo. */
  explicitConnectionPin?: boolean;
  /**
   * Homelab (ZAC-267): keep-warm ping. The forced connection or none: no sibling
   * fallback, no session-affinity override, no reviving an inactive connection.
   */
  strictForcedConnection?: boolean;
  excludeConnectionIds?: string[] | null;
  /**
   * Homelab (ZAC-263): ordered account tiers (claudeRoleTiers). Selection keeps
   * the first tier that still has an available account; the occupancy spill
   * never crosses tiers.
   */
  connectionTiers?: string[][] | null;
  sessionKey?: string | null;
  sessionAffinityTtlMs?: number | null;
  reserveOAuthSession?: boolean;
  lease?: CredentialLeaseSelectionContext;
  materializeCredentials?: boolean;
  deferLeaseClaim?: boolean;
  /** Internal: a same-call UNIQUE retry already holds the provider/owner selection lock. */
  _leaseRetryWithLockHeld?: boolean;
  /** Internal: freeze the original policy-valid candidate set across lease race/preflight retry. */
  _leaseCandidateIds?: string[];
  /** Antigravity account lease (#10011): only the final chat dispatch opts in. */
  reserveAntigravityLease?: boolean;
  routingRequestId?: string | null;
}
