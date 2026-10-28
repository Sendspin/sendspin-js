export interface KnownViolation {
  /** Gap ID from the spec alignment audit. */
  gap: string;
  /** Stable part of the server's non-compliance log message. */
  message: string;
}

/** Non-compliance the client still shows, removed as each gap is fixed. */
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  {
    gap: "G25",
    message:
      "client/hello declared player supported_commands, superseded by client/state",
  },
  {
    gap: "G29",
    message: "client/hello sent the removed trust_level key",
  },
];
