import type { PskStore, PskCategory } from "./noise/psk";
import { base64urlEncode } from "./noise/base64url";

export type PairingEvent = "started" | "finalized" | "aborted";

export interface PairingDeps {
  sendControl(msg: object): void;
  /** Close the WebSocket. pair/abort requires the sender to close after sending. */
  close(): void;
  pskStore: PskStore;
  serverId(): string;
  matchedCategory(): PskCategory;
  onEvent?(e: PairingEvent, detail?: string): void;
}

export class PairingManager {
  private pendingPsk: Uint8Array | null = null;

  constructor(private deps: PairingDeps) {}

  /** Called for every server/activate. Returns true if it consumed a pairing activation. */
  onActivate(activities: string[], selectedPairMethod?: string): boolean {
    const isPairing = activities.includes("pairing");
    if (!isPairing) {
      // Non-pairing activate after we sent pair-finalize = leave-pairing: persist nothing.
      this.pendingPsk = null;
      return false;
    }
    if (
      selectedPairMethod !== "pairing_psk" ||
      this.deps.matchedCategory() !== "pairing"
    ) {
      this.deps.sendControl({
        type: "pair/abort",
        payload: { reason: "method_not_supported" },
      });
      this.deps.onEvent?.("aborted", "method_not_supported");
      this.deps.close(); // spec: the sender closes the connection after pair/abort
      return true;
    }
    if (this.pendingPsk) return true; // finalize already in flight, do not re-mint
    // A Sendspin PSK must be a 32-byte CSPRNG value, not a clamped X25519 private key.
    const psk = crypto.getRandomValues(new Uint8Array(32));
    this.pendingPsk = psk;
    this.deps.sendControl({
      type: "client/pair-finalize",
      payload: { long_term_psk: base64urlEncode(psk) },
    });
    this.deps.onEvent?.("started");
    return true;
  }

  onPairFinalize(): void {
    if (!this.pendingPsk) return;
    this.deps.pskStore.addLongTerm(this.pendingPsk, this.deps.serverId());
    this.pendingPsk = null;
    this.deps.onEvent?.("finalized");
  }

  /** Inbound pair/abort from the server: discard pending state and close. */
  onAbort(reason: string): void {
    this.pendingPsk = null;
    this.deps.onEvent?.("aborted", reason);
    this.deps.close();
  }

  /** Discard any in-flight pairing state, e.g. on transport close. */
  reset(): void {
    this.pendingPsk = null;
  }
}
