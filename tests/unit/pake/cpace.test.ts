import { describe, it, expect } from "vitest";
import {
  CPace,
  CPaceError,
  calculateGenerator,
  generatorString,
  lvCat,
  prependLen,
} from "../../../src/core/pake/cpace";
import { derivePin } from "../../../src/core/pake/pin";

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// draft-irtf-cfrg-cpace-13 appendix B.1 (X25519, SHA-512) test vectors.
const DRAFT = {
  prs: utf8("Password"),
  ci: hex("6f630b425f726573706f6e6465720b415f696e69746961746f72"),
  sid: hex("7e4b4791d6a8ef019b936c79fb7f2c57"),
  g: "64e8099e3ea682cfdc5cb665c057ebb514d06bf23ebc9f743b51b82242327074",
  ya: hex("21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080"),
  Ya: "1b02dad6dbd29a07b6d28c9e04cb2f184f0734350e32bb7e62ff9dbcfdb63d15",
  yb: hex("848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a"),
  Yb: "20cda5955f82c4931545bcbf40758ce1010d7db4db2a907013d79c7a8fcf957f",
};

describe("prependLen / lvCat", () => {
  it("uses LEB128 length prefixes", () => {
    expect(toHex(prependLen(new Uint8Array(0)))).toBe("00");
    expect(toHex(prependLen(utf8("1234")))).toBe("0431323334");
    expect(prependLen(new Uint8Array(128)).slice(0, 2)).toEqual(
      new Uint8Array([0x80, 0x01]),
    );
    expect(toHex(lvCat(utf8("12"), utf8("3")))).toBe("0231320133");
  });
});

describe("generator calculation (draft B.1)", () => {
  it("builds the generator string with correct zero padding", () => {
    const gs = generatorString(DRAFT.prs, DRAFT.ci, DRAFT.sid);
    // lv(DSI=8) + lv(PRS=8) + lv(zpad=109) + lv(CI=26) + lv(sid=16)
    expect(gs.length).toBe(9 + 9 + 110 + 27 + 17);
    expect(toHex(gs.slice(0, 9))).toBe("084350616365323535");
  });

  it("maps to the expected generator via Elligator2", () => {
    expect(toHex(calculateGenerator(DRAFT.prs, DRAFT.ci, DRAFT.sid))).toBe(
      DRAFT.g,
    );
  });

  it("computes the draft public shares and agrees on K", () => {
    const a = CPace.start({
      role: "initiator",
      prs: DRAFT.prs,
      sid: DRAFT.sid,
      ci: DRAFT.ci,
      scalar: DRAFT.ya,
    });
    const b = CPace.start({
      role: "responder",
      prs: DRAFT.prs,
      sid: DRAFT.sid,
      ci: DRAFT.ci,
      scalar: DRAFT.yb,
    });
    expect(toHex(a.publicShare)).toBe(DRAFT.Ya);
    expect(toHex(b.publicShare)).toBe(DRAFT.Yb);
    a.derive(b.publicShare);
    b.derive(a.publicShare);
    // Mutual confirmation closes the loop over the same ISK.
    expect(b.verify(a.tag())).toBe(true);
    expect(a.verify(b.tag())).toBe(true);
  });
});

describe("associated data (reflected-MAC protection)", () => {
  it("binds distinct ADa/ADb so a reflected tag cannot pass", () => {
    // Force identical shares (same scalar) to isolate the AD's effect.
    const opts = {
      prs: DRAFT.prs,
      sid: DRAFT.sid,
      scalar: DRAFT.yb,
      ada: utf8("server"),
      adb: utf8("client"),
    } as const;
    const a = CPace.start({ role: "initiator", ...opts });
    const b = CPace.start({ role: "responder", ...opts });
    expect(toHex(a.publicShare)).toBe(toHex(b.publicShare)); // shares match
    a.derive(b.publicShare);
    b.derive(a.publicShare);
    // Identical shares, but ADa != ADb makes Ta != Tb.
    expect(toHex(a.tag())).not.toBe(toHex(b.tag()));
    // The initiator's own tag must not verify as the peer's (no reflection).
    expect(a.verify(a.tag())).toBe(false);
  });

  it("changes the ISK when the AD changes", () => {
    const mk = (ada: Uint8Array, adb: Uint8Array) => {
      const b = CPace.start({
        role: "responder",
        prs: DRAFT.prs,
        sid: DRAFT.sid,
        scalar: DRAFT.yb,
        ada,
        adb,
      });
      b.derive(hex(DRAFT.Ya));
      return toHex(b.isk);
    };
    expect(mk(utf8("server"), utf8("client"))).not.toBe(
      mk(new Uint8Array(0), new Uint8Array(0)),
    );
  });
});

describe("low-order peer shares (draft B.1.10)", () => {
  const lowOrder = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
    "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ];

  it.each(lowOrder)("aborts on %s", (u) => {
    const b = CPace.start({
      role: "responder",
      prs: DRAFT.prs,
      sid: DRAFT.sid,
      scalar: DRAFT.yb,
    });
    expect(() => b.derive(hex(u))).toThrow(CPaceError);
  });

  it("rejects a peer share of the wrong length", () => {
    const b = CPace.start({
      role: "responder",
      prs: DRAFT.prs,
      sid: DRAFT.sid,
    });
    expect(() => b.derive(new Uint8Array(31))).toThrow(CPaceError);
  });
});

// CPace primitive vector generated with the aiosendspin reference implementation
// (empty CI/ADs, sid = "sendspin-pair-pake-v1" || h). It predates the spec's
// ADa/ADb = "server"/"client" and the sid attempt counter, so it pins the
// primitive with empty AD; Sendspin's wire instantiation is covered in
// pairing.test.ts. Re-pin against updated aiosendspin when available.
describe("aiosendspin interop vector (empty-AD primitive)", () => {
  const h = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const nonceA = new Uint8Array(32).fill(0xaa);
  const nonceB = new Uint8Array(32).fill(0xbb);
  const sid = new Uint8Array([...utf8("sendspin-pair-pake-v1"), ...h]);
  const ya = new Uint8Array(32).fill(0x11);
  const yb = new Uint8Array(32).fill(0x22);

  it("derives the expected PIN", () => {
    expect(derivePin(h, nonceA, nonceB, 6)).toBe("899599");
  });

  it("matches the reference generator, shares, and confirmation tags", () => {
    const pin = derivePin(h, nonceA, nonceB, 6);
    const prs = utf8(pin);
    expect(toHex(calculateGenerator(prs, new Uint8Array(0), sid))).toBe(
      "83868197583cdca51bbb655ec3949040250b8789bdfb79503c255f6898de662b",
    );
    const client = CPace.start({ role: "responder", prs, sid, scalar: yb });
    expect(toHex(client.publicShare)).toBe(
      "8af486bd12c5d7363555510b852cb46aa0ef5eaf9007c6138c00d726c4becf79",
    );
    const serverYa = hex(
      "e2f2ceed856d39ece11d9454df7bdc83bff3c7fd7c133ca6a339e1fbe84b5031",
    );
    client.derive(serverYa);
    const refTa = hex(
      "4e624b0a86a24e78a11b76c406d6588f0930fd4e46996ba42858c5ea80a65a41d92a4072dde18d93f807cc462c27d793340a79fd84858d5eabcb64b97aa89e01",
    );
    const refTb =
      "769a76945c1c8bd8fc6997f28b7e8ba65347cc02769d7df30f9985decbdeb8d2d714583e4227888e23b6499c7fed0d1ffe605d1fa5b18f14bb1b4265818f807d";
    expect(client.verify(refTa)).toBe(true);
    expect(toHex(client.tag())).toBe(refTb);
    // A flipped tag byte must not verify.
    const bad = refTa.slice();
    bad[0] ^= 1;
    expect(client.verify(bad)).toBe(false);
  });
});

describe("derivePin", () => {
  const h = new Uint8Array(32).fill(1);
  const na = new Uint8Array(32).fill(2);
  const nb = new Uint8Array(32).fill(3);

  it("zero-pads to the requested length", () => {
    for (const len of [4, 6, 8, 12]) {
      const pin = derivePin(h, na, nb, len);
      expect(pin).toMatch(new RegExp(`^[0-9]{${len}}$`));
    }
  });

  it("changes with any input", () => {
    const base = derivePin(h, na, nb, 8);
    expect(derivePin(new Uint8Array(32).fill(9), na, nb, 8)).not.toBe(base);
    expect(derivePin(h, new Uint8Array(32).fill(9), nb, 8)).not.toBe(base);
    expect(derivePin(h, na, new Uint8Array(32).fill(9), 8)).not.toBe(base);
  });
});
