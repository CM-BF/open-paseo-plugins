import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectWav, isSilent, resolveAudioMime, SILENCE_PEAK } from "./audio";
import { SAMPLE_SHA256, sampleWav } from "./sample";
import { makeWav, tone } from "./test-helpers";

describe("inspectWav", () => {
  it("measures duration and peak of PCM16 audio", () => {
    const info = inspectWav(makeWav(tone(1.5, 9_000)));
    expect(info?.sampleRate).toBe(24_000);
    expect(info?.seconds).toBeCloseTo(1.5, 3);
    expect(info?.peak).toBeGreaterThan(8_900);
    expect(isSilent(info)).toBe(false);
  });

  it("treats quiet or very short clips as silence", () => {
    expect(isSilent(inspectWav(makeWav(tone(2, SILENCE_PEAK - 50))))).toBe(true);
    expect(isSilent(inspectWav(makeWav(new Int16Array(24_000 * 2))))).toBe(true);
    expect(isSilent(inspectWav(makeWav(tone(0.1, 9_000))))).toBe(true);
  });

  it("skips Apple FLLR padding chunks in the bundled sample", () => {
    const audio = sampleWav();
    expect(createHash("sha256").update(audio).digest("hex")).toBe(SAMPLE_SHA256);
    const info = inspectWav(audio);
    expect(info?.sampleRate).toBe(16_000);
    expect(info?.seconds).toBeGreaterThan(4);
    expect(isSilent(info)).toBe(false);
  });

  it("returns null for other containers", () => {
    expect(inspectWav(Buffer.from("ID3 not a wav file"))).toBeNull();
    expect(isSilent(null)).toBe(false);
  });
});

describe("resolveAudioMime", () => {
  const wav = makeWav(tone(0.5));
  it("detects WAV even when uploaded as octet-stream", () => {
    expect(resolveAudioMime("audio.bin", "application/octet-stream", wav)).toBe("audio/wav");
  });
  it("normalizes WAV aliases and keeps other audio types", () => {
    expect(resolveAudioMime(undefined, "audio/x-wav", Buffer.alloc(4))).toBe("audio/wav");
    expect(resolveAudioMime(undefined, "audio/ogg; codecs=opus", Buffer.alloc(4))).toBe("audio/ogg");
  });
  it("falls back to the file extension", () => {
    expect(resolveAudioMime("clip.m4a", undefined, Buffer.alloc(4))).toBe("audio/m4a");
  });
});
