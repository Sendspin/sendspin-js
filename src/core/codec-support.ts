import type { Codec, SupportedFormat } from "../types";

/** Detect which audio codecs the current browser supports. */
export function getBrowserSupportedCodecs(): Set<Codec> {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  const isFirefox = /firefox/i.test(userAgent);

  // Check if native Opus decoder is available (requires secure context)
  const hasNativeOpus = typeof AudioDecoder !== "undefined";

  if (!hasNativeOpus) {
    if (typeof window !== "undefined" && !window.isSecureContext) {
      console.warn(
        "[Opus] Running in insecure context, falling back to FLAC/PCM",
      );
    } else {
      console.warn(
        "[Opus] Native decoder not available, falling back to FLAC/PCM",
      );
    }
  }

  if (isSafari) {
    // Safari: No FLAC support
    return new Set(["pcm", "opus"] as Codec[]);
  }

  if (isFirefox) {
    // Firefox: Opus has audio glitches with both native and opus-encdec decoders
    return new Set(["pcm", "flac"] as Codec[]);
  }

  if (hasNativeOpus) {
    // Native Opus available (Chrome, Edge)
    return new Set(["pcm", "opus", "flac"] as Codec[]);
  }

  // No WebCodecs AudioDecoder (insecure context or unsupported browser)
  return new Set(["pcm", "flac"] as Codec[]);
}

/** Build supported format list from requested codecs, filtering by browser support. */
export function getSupportedFormats(codecs: Codec[]): SupportedFormat[] {
  const browserSupported = getBrowserSupportedCodecs();
  const formats: SupportedFormat[] = [];

  for (const codec of codecs) {
    if (!browserSupported.has(codec)) {
      continue;
    }

    if (codec === "opus") {
      // Opus requires 48kHz
      formats.push({
        codec: "opus",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      });
    } else {
      // PCM and FLAC support both sample rates
      formats.push({ codec, sample_rate: 48000, channels: 2, bit_depth: 16 });
      formats.push({ codec, sample_rate: 44100, channels: 2, bit_depth: 16 });
    }
  }

  if (formats.length === 0) {
    throw new Error(
      `No supported codecs: requested [${codecs.join(", ")}], ` +
        `browser supports [${[...browserSupported].join(", ")}]`,
    );
  }

  return formats;
}
