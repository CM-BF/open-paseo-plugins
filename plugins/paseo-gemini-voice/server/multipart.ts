export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType.trim())) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  return boundary ? boundary : null;
}

function headerParam(header: string, name: string): string | undefined {
  const quoted = new RegExp(`(?:^|;)\\s*${name}="((?:[^"\\\\]|\\\\.)*)"`, "i").exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, "i").exec(header);
  return bare ? bare[1].trim() : undefined;
}

/** Parses an RFC 7578 body, as produced by the OpenAI SDK's audio upload. */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new Error("multipart body has no boundary");
  cursor += delimiter.length;
  for (;;) {
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "--") break;
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "\r\n") cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd < 0) throw new Error("multipart part has no header terminator");
    const headers = body.subarray(cursor, headerEnd).toString("utf8").split("\r\n");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(separator, dataStart);
    if (next < 0) throw new Error("multipart body is truncated");
    let name: string | undefined;
    let filename: string | undefined;
    let contentType: string | undefined;
    for (const line of headers) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === "content-disposition") {
        name = headerParam(value, "name");
        filename = headerParam(value, "filename");
      } else if (key === "content-type") {
        contentType = value;
      }
    }
    if (name !== undefined) {
      parts.push({
        name,
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType ? { contentType } : {}),
        data: body.subarray(dataStart, next),
      });
    }
    cursor = next + separator.length;
  }
  return parts;
}
