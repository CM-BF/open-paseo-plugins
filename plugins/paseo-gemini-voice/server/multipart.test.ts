import { describe, expect, it } from "vitest";
import { parseBoundary, parseMultipart } from "./multipart";

async function encode(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const request = new Request("http://127.0.0.1/v1/audio/transcriptions", { method: "POST", body: form });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "",
  };
}

describe("multipart", () => {
  it("reads the file and text fields that the OpenAI SDK sends", async () => {
    const audio = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255, 254]);
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "audio-1.wav");
    form.append("model", "paseo-gemini-voice");
    form.append("language", "en");
    form.append("prompt", "Transcribe only what the speaker says. 中文也可以。");
    form.append("response_format", "json");
    const { body, contentType } = await encode(form);

    const boundary = parseBoundary(contentType);
    expect(boundary).toBeTruthy();
    const parts = parseMultipart(body, boundary!);
    const file = parts.find((part) => part.name === "file");
    expect(file?.filename).toBe("audio-1.wav");
    expect(file?.contentType).toBe("audio/wav");
    expect(Buffer.compare(file!.data, audio)).toBe(0);
    const fields = Object.fromEntries(parts.filter((part) => part.name !== "file").map((part) => [part.name, part.data.toString("utf8")]));
    expect(fields).toEqual({
      model: "paseo-gemini-voice",
      language: "en",
      prompt: "Transcribe only what the speaker says. 中文也可以。",
      response_format: "json",
    });
  });

  it("accepts quoted boundaries and rejects other content types", () => {
    expect(parseBoundary('multipart/form-data; boundary="abc def"')).toBe("abc def");
    expect(parseBoundary("multipart/form-data; boundary=xyz")).toBe("xyz");
    expect(parseBoundary("application/json")).toBeNull();
    expect(parseBoundary(undefined)).toBeNull();
  });

  it("rejects a truncated body", () => {
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"\r\n\r\npartial');
    expect(() => parseMultipart(body, "b")).toThrow(/truncated/);
  });
});
