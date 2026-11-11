import { createElement, type ReactElement } from "react";

type DownloadLink = { href: string; download: string; click(): void; remove(): void };
const browser = globalThis as unknown as {
  document?: { createElement(tag: string): DownloadLink; body: { appendChild(node: DownloadLink): void } };
  URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
  Blob?: new (data: unknown[], options: { type: string }) => unknown;
  atob?(data: string): string;
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
};
/** Previews need a DOM; without one an update could be confirmed unseen. */
export const canPreviewRelease = () => !!browser.document;
export async function copyText(text: string): Promise<void> {
  if (!browser.navigator?.clipboard) throw new Error("此客户端无法复制，请手动选择链接文字。");
  await browser.navigator.clipboard.writeText(text);
}

export function downloadReleaseZip(base64: string, fileName: string): void {
  if (!browser.document || !browser.URL || !browser.Blob || !browser.atob) throw new Error("此客户端无法下载文件，请使用导出目录或桌面版。");
  const bytes = Uint8Array.from(browser.atob(base64), character => character.charCodeAt(0));
  const url = browser.URL.createObjectURL(new browser.Blob([bytes], { type: "application/zip" }));
  const link = browser.document.createElement("a");
  link.href = url; link.download = fileName; browser.document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => browser.URL?.revokeObjectURL(url), 60_000); }
}

/** Runs only the immutable exported viewer, without a bridge to the private Board. */
export function ReleasePreview({ html }: { html: string }): ReactElement | null {
  if (!browser.document) return null;
  return createElement("iframe", {
    title: "发布版本预览", "data-testid": "board-release-preview", srcDoc: html,
    sandbox: "allow-scripts allow-forms", referrerPolicy: "no-referrer",
    style: { width: "100%", height: 440, border: "1px solid #80808055", borderRadius: 8, background: "#fff" },
  });
}
