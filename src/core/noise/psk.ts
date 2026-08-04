import type { SendspinStorage } from "../../types";
import { SENTINEL_PSK, pskId } from "./constants";
import { base64urlEncode, base64urlDecode } from "./base64url";

/** A Sendspin PSK is 32 bytes from a CSPRNG. */
function randomPsk(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export type PskCategory = "sentinel" | "pairing" | "long_term";

export interface PskEntry {
  psk: Uint8Array;
  pskId: string;
  category: PskCategory;
  /** Present on stored-pubkey long-term records; undefined for shared-PSK and sentinel/pairing. */
  serverId?: string;
}

const LONG_TERM_KEY = "sendspin-psks";
const PAIRING_KEY = "sendspin-pairing-psk";

interface StoredRecord {
  psk: string; // base64url
  serverId?: string;
}

export class PskStore {
  private entries = new Map<string, PskEntry>();

  constructor(private storage: SendspinStorage | null) {
    // Always a candidate: every unpaired connection's handshake matches its psk_id.
    this.add({
      psk: SENTINEL_PSK,
      pskId: pskId(SENTINEL_PSK),
      category: "sentinel",
    });
    this.loadPersisted();
  }

  private add(e: PskEntry): void {
    this.entries.set(e.pskId, e);
  }

  private loadPersisted(): void {
    if (!this.storage) return;
    // Treat a corrupt entry as no stored PSK and clear it, rather than
    // letting a parse error abort connection setup.
    const raw = this.storage.getItem(LONG_TERM_KEY);
    if (raw) {
      try {
        const records = JSON.parse(raw) as StoredRecord[];
        for (const r of records) {
          const psk = base64urlDecode(r.psk);
          this.add({
            psk,
            pskId: pskId(psk),
            category: "long_term",
            serverId: r.serverId,
          });
        }
      } catch {
        this.storage.setItem(LONG_TERM_KEY, "[]");
      }
    }
    const pairing = this.storage.getItem(PAIRING_KEY);
    if (pairing) {
      try {
        const psk = base64urlDecode(pairing);
        this.add({ psk, pskId: pskId(psk), category: "pairing" });
      } catch {
        this.storage.setItem(PAIRING_KEY, "");
      }
    }
  }

  private persistLongTerm(): void {
    if (!this.storage) return;
    const records: StoredRecord[] = [];
    for (const e of this.entries.values()) {
      if (e.category === "long_term") {
        records.push({ psk: base64urlEncode(e.psk), serverId: e.serverId });
      }
    }
    this.storage.setItem(LONG_TERM_KEY, JSON.stringify(records));
  }

  lookup(id: string): PskEntry | null {
    return this.entries.get(id) ?? null;
  }

  addLongTerm(psk: Uint8Array, serverId?: string): PskEntry {
    const e: PskEntry = {
      psk,
      pskId: pskId(psk),
      category: "long_term",
      serverId,
    };
    this.add(e);
    this.persistLongTerm();
    return e;
  }

  /** Remove a long-term entry unless it is a shared-PSK record (no serverId). */
  removeByPskId(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.category !== "long_term" || e.serverId === undefined) return;
    this.entries.delete(id);
    this.persistLongTerm();
  }

  getOrCreatePairingPsk(): Uint8Array {
    for (const e of this.entries.values()) {
      if (e.category === "pairing") return e.psk;
    }
    return this.setPairingPsk(randomPsk());
  }

  rotatePairingPsk(): Uint8Array {
    for (const [id, e] of this.entries) {
      if (e.category === "pairing") this.entries.delete(id);
    }
    return this.setPairingPsk(randomPsk());
  }

  private setPairingPsk(psk: Uint8Array): Uint8Array {
    this.add({ psk, pskId: pskId(psk), category: "pairing" });
    this.storage?.setItem(PAIRING_KEY, base64urlEncode(psk));
    return psk;
  }
}
