export interface KnownViolation {
  /** Gap ID from the spec alignment audit. */
  gap: string;
  /** Stable part of the server's non-compliance log message. */
  message: string;
}

/** Non-compliance the client still shows, removed as each gap is fixed. */
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  {
    gap: "G13",
    message: "client/hello sent supported_pair_methods as a list",
  },
  {
    gap: "G14",
    message: "client/hello offered the pre-rename PIN pairing methods",
  },
  {
    gap: "G20",
    message: "Pairing PSK client/pair-finalize sent without client/pair-init",
  },
  {
    gap: "G25",
    message:
      "client/hello declared player supported_commands, superseded by client/state",
  },
  {
    gap: "G29",
    message: "client/hello sent the removed trust_level key",
  },
  {
    gap: "G45",
    message: "pair/abort sent the pre-rename pin_mismatch reason",
  },
];
