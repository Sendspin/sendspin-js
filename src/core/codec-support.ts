import type { Codec, SupportedFormat } from "../types";

// Depth of buffered audio the server streams ahead, in seconds. Servers gate
// the send queue on both bytes (buffer_capacity) and duration; aiosendspin's
// duration horizon is 30s. Sizing the advertised byte capacity below that depth
// makes bytes the binding limit and starves the buffer on high-rate codecs.
const BUFFER_DEPTH_SECONDS = 30;

// FLAC falls back to verbatim frames on incompressible audio, where the frame
// headers put the stream slightly above raw PCM. Measured at 195.4 kB/s for
// 48kHz/16-bit stereo (192.0 kB/s raw) with full-scale decorrelated noise.
const FLAC_WORST_CASE_EXPANSION = 1.02;

// libopus tops out at 512 kbps for stereo. Servers pick their own bitrate
// (aiosendspin uses the libopus default, ~96 kbps), so assume the ceiling
// rather than tying the capacity to any one server's encoder settings.
const OPUS_MAX_BYTES_PER_SECOND = 64_000;

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

/**
 * Build the client/hello format list from the requested codecs, in priority
 * order and filtered by browser support. Always contains a flac or pcm entry.
 */
export function getSupportedFormats(codecs: Codec[]): SupportedFormat[] {
  const browserSupported = getBrowserSupportedCodecs();
  const selected = codecs.filter((codec) => browserSupported.has(codec));

  // Servers only have to support flac and pcm, so the protocol requires at
  // least one of them in the list. When neither was requested or survived the
  // filter, append both (where the browser decodes them) at lowest priority,
  // flac first for its lower bandwidth.
  if (!selected.includes("flac") && !selected.includes("pcm")) {
    const fallback = (["flac", "pcm"] as Codec[]).filter((codec) =>
      browserSupported.has(codec),
    );
    console.warn(
      `[Codec] No flac or pcm in usable codecs [${selected.join(", ")}] ` +
        `(requested [${codecs.join(", ")}]), advertising ` +
        `[${fallback.join(", ")}] as fallback`,
    );
    selected.push(...fallback);
  }

  const formats: SupportedFormat[] = [];
  for (const codec of selected) {
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

  return formats;
}

/** Worst-case wire byte rate for a single advertised format. */
function getWireByteRate(format: SupportedFormat): number {
  const pcmByteRate =
    format.sample_rate * format.channels * Math.ceil(format.bit_depth / 8);

  switch (format.codec) {
    case "opus":
      return OPUS_MAX_BYTES_PER_SECOND;
    case "flac":
      return pcmByteRate * FLAC_WORST_CASE_EXPANSION;
    default:
      return pcmByteRate;
  }
}

/**
 * Buffer capacity to advertise for a set of supported formats, in bytes.
 *
 * The server picks one of the advertised formats, so the capacity is sized for
 * the highest byte rate among them: enough for the full stream-ahead depth even
 * on incompressible FLAC without making bytes the binding limit before the
 * server's duration horizon.
 *
 * @param formats - Formats advertised in `client/hello`, as returned by `getSupportedFormats`
 */
export function getDefaultBufferCapacity(formats: SupportedFormat[]): number {
  const worstByteRate = Math.max(...formats.map(getWireByteRate));
  return Math.ceil(worstByteRate * BUFFER_DEPTH_SECONDS);
}
