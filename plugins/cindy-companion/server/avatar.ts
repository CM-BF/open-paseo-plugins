import { string, throwIpcError } from './errors';
/** Validate the bytes, not the user-controlled data URL media type. */
export function avatarDataUrl(value: unknown): string {
  const raw = string(value, 'avatar', 1800000).replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throwIpcError('INVALID_PARAMS', 'Invalid avatar image');
  const bytes = Buffer.from(raw, 'base64');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
    bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (!mime) throwIpcError('INVALID_PARAMS', 'Avatar must be PNG, JPEG or WebP');
  return `data:${mime};base64,${raw}`;
}
