export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  seconds: number;
  /** Peak absolute 16-bit sample; null when the samples are not PCM16. */
  peak: number | null;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mp3",
  m4a: "audio/m4a",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  webm: "audio/webm",
  flac: "audio/flac",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

/** Gemini needs a real audio type; the OpenAI SDK often uploads application/octet-stream. */
export function resolveAudioMime(filename: string | undefined, declared: string | undefined, data: Buffer): string {
  const type = declared?.split(";")[0].trim().toLowerCase();
  if (type && type.startsWith("audio/")) return type === "audio/x-wav" || type === "audio/wave" ? "audio/wav" : type;
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WAVE") {
    return "audio/wav";
  }
  const extension = filename?.split(".").pop()?.toLowerCase();
  return (extension && MIME_BY_EXTENSION[extension]) ?? "audio/wav";
}

/** Reads a RIFF/WAVE header and, for PCM16, the peak sample. Returns null for other containers. */
export function inspectWav(data: Buffer): WavInfo | null {
  if (data.length < 12) return null;
  if (data.subarray(0, 4).toString("latin1") !== "RIFF" || data.subarray(8, 12).toString("latin1") !== "WAVE") {
    return null;
  }
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString("latin1");
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= data.length) {
      format = {
        audioFormat: data.readUInt16LE(start),
        channels: data.readUInt16LE(start + 2),
        sampleRate: data.readUInt32LE(start + 4),
        bitsPerSample: data.readUInt16LE(start + 14),
      };
    } else if (id === "data" && format) {
      const end = Math.min(data.length, start + size);
      const bytesPerFrame = Math.max(1, (format.channels * format.bitsPerSample) / 8);
      const seconds = format.sampleRate > 0 ? (end - start) / bytesPerFrame / format.sampleRate : 0;
      let peak: number | null = null;
      if (format.audioFormat === 1 && format.bitsPerSample === 16) {
        peak = 0;
        for (let index = start; index + 1 < end; index += 2) {
          const sample = Math.abs(data.readInt16LE(index));
          if (sample > peak) peak = sample;
        }
      }
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: format.bitsPerSample,
        seconds,
        peak,
      };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

/** Below this peak a PCM16 clip is room noise; Gemini tends to invent words for it. */
export const SILENCE_PEAK = 250;
export const MIN_SPEECH_SECONDS = 0.25;

export function isSilent(info: WavInfo | null): boolean {
  if (!info) return false;
  if (info.seconds < MIN_SPEECH_SECONDS) return true;
  return info.peak !== null && info.peak < SILENCE_PEAK;
}
