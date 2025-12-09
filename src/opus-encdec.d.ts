// Type declarations for opus-encdec library
declare module "opus-encdec/dist/libopus-decoder.js" {
  interface OpusDecoderModule {
    isReady: boolean;
    onready?: () => void;
    _opus_decoder_create: any;
    _opus_decoder_destroy: any;
    _opus_decode_float: any;
    _speex_resampler_init: any;
    _speex_resampler_destroy: any;
    _speex_resampler_process_interleaved_float: any;
    _malloc: any;
    _free: any;
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
  }
  const module: OpusDecoderModule;
  export default module;
}

declare module "opus-encdec/dist/libopus-decoder.wasm.js" {
  interface OpusDecoderModule {
    isReady: boolean;
    onready?: () => void;
  }
  const module: OpusDecoderModule;
  export default module;
}

declare module "opus-encdec/src/oggOpusDecoder.js" {
  export class OggOpusDecoder {
    constructor(config: any, module: any);
    isReady: boolean;
    onready?: () => void;
    decodeRaw(
      data: Uint8Array,
      callback: (samples: Float32Array) => void,
      userData?: any,
    ): void;
  }
}
