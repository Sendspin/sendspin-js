/**
 * Unit tests for the codec-support module.
 *
 * Covers browser codec detection (Safari / Firefox / Chrome, with and without
 * WebCodecs AudioDecoder), format expansion rules, browser filtering of
 * requested codecs, and the "no supported codecs" throw.
 *
 * navigator / AudioDecoder / window don't exist in node; each test installs
 * the minimal globals it needs and restores them afterward.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getBrowserSupportedCodecs,
  getSupportedFormats,
} from "../../src/core/codec-support";
import type { Codec } from "../../src/types";

const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
};

function setEnv(opts: {
  userAgent?: string;
  hasAudioDecoder?: boolean;
  isSecureContext?: boolean;
}): void {
  if (opts.userAgent !== undefined) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: opts.userAgent },
      configurable: true,
      writable: true,
    });
  }
  if (opts.hasAudioDecoder) {
    (globalThis as any).AudioDecoder = class {};
  } else {
    delete (globalThis as any).AudioDecoder;
  }
  if (opts.isSecureContext !== undefined) {
    (globalThis as any).window = { isSecureContext: opts.isSecureContext };
  }
}

function clearEnv(): void {
  if (Object.getOwnPropertyDescriptor(globalThis, "navigator")?.configurable) {
    delete (globalThis as any).navigator;
  }
  delete (globalThis as any).AudioDecoder;
  delete (globalThis as any).window;
}

describe("getBrowserSupportedCodecs", () => {
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("Chrome with WebCodecs supports pcm, opus, and flac", () => {
    setEnv({ userAgent: UA.chrome, hasAudioDecoder: true });
    const codecs = getBrowserSupportedCodecs();
    expect([...codecs].sort()).toEqual(["flac", "opus", "pcm"]);
  });

  it("Safari supports pcm and opus but not flac", () => {
    setEnv({ userAgent: UA.safari, hasAudioDecoder: true });
    const codecs = getBrowserSupportedCodecs();
    expect(codecs.has("flac")).toBe(false);
    expect(codecs.has("opus")).toBe(true);
    expect(codecs.has("pcm")).toBe(true);
  });

  it("Firefox supports pcm and flac but not opus", () => {
    setEnv({ userAgent: UA.firefox, hasAudioDecoder: true });
    const codecs = getBrowserSupportedCodecs();
    expect(codecs.has("opus")).toBe(false);
    expect(codecs.has("flac")).toBe(true);
    expect(codecs.has("pcm")).toBe(true);
  });

  it("Chrome without WebCodecs (insecure context) drops opus", () => {
    setEnv({
      userAgent: UA.chrome,
      hasAudioDecoder: false,
      isSecureContext: false,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const codecs = getBrowserSupportedCodecs();
    expect(codecs.has("opus")).toBe(false);
    expect([...codecs].sort()).toEqual(["flac", "pcm"]);
  });

  it("falls back to pcm/flac when no navigator is present", () => {
    // No navigator, no AudioDecoder => userAgent treated as "".
    setEnv({ userAgent: "", hasAudioDecoder: false });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const codecs = getBrowserSupportedCodecs();
    expect([...codecs].sort()).toEqual(["flac", "pcm"]);
  });
});

describe("getSupportedFormats", () => {
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("expands opus to a single 48kHz format only", () => {
    setEnv({ userAgent: UA.chrome, hasAudioDecoder: true });
    const formats = getSupportedFormats(["opus"]);
    expect(formats.length).toBe(1);
    expect(formats[0].codec).toBe("opus");
    expect(formats[0].sample_rate).toBe(48000);
  });

  it("expands pcm to both 48kHz and 44.1kHz", () => {
    setEnv({ userAgent: UA.chrome, hasAudioDecoder: true });
    const formats = getSupportedFormats(["pcm"]);
    const rates = formats.map((f) => f.sample_rate).sort();
    expect(rates).toEqual([44100, 48000]);
    expect(formats.every((f) => f.codec === "pcm")).toBe(true);
  });

  it("preserves requested codec priority order", () => {
    setEnv({ userAgent: UA.chrome, hasAudioDecoder: true });
    const formats = getSupportedFormats(["flac", "opus", "pcm"]);
    // First codec encountered should appear first in the output.
    expect(formats[0].codec).toBe("flac");
    const codecOrder = formats.map((f) => f.codec);
    expect(codecOrder.indexOf("flac")).toBeLessThan(codecOrder.indexOf("opus"));
    expect(codecOrder.indexOf("opus")).toBeLessThan(codecOrder.indexOf("pcm"));
  });

  it("filters out codecs the browser does not support", () => {
    // Firefox: opus unsupported. Requesting opus+flac should drop opus.
    setEnv({ userAgent: UA.firefox, hasAudioDecoder: true });
    const formats = getSupportedFormats(["opus", "flac"]);
    expect(formats.every((f) => f.codec === "flac")).toBe(true);
    expect(formats.some((f) => f.codec === "opus")).toBe(false);
  });

  it("throws when every requested codec is unsupported", () => {
    // Firefox does not support opus; requesting only opus leaves nothing.
    setEnv({ userAgent: UA.firefox, hasAudioDecoder: true });
    expect(() => getSupportedFormats(["opus"])).toThrow(/No supported codecs/);
  });
});
