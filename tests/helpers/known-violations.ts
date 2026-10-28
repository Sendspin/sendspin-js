export interface KnownViolation {
  /** Gap ID from the spec alignment audit. */
  gap: string;
  /** Stable part of the server's non-compliance log message. */
  message: string;
}

/** Non-compliance the client still shows, removed as each gap is fixed. */
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [];
