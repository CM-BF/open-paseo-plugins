import { FONT_CHUNK_BYTES, FONT_MANIFEST, type FontWeightName } from '../shared/font-manifest';
import { FONT_ASSETS } from './generated/font-assets';
import { throwIpcError } from './errors';

export interface FontChunk {
  font: FontWeightName; offset: number; totalBytes: number; sha256: string;
  data: string; nextOffset: number | null;
}

/** Fixed, public build assets only. No filesystem paths, user sizes, mutable cache or extra listener. */
export function readFontChunk(args: Record<string, unknown>): FontChunk {
  if (Object.keys(args).some(key => key !== 'font' && key !== 'offset'))
    throwIpcError('INVALID_PARAMS', 'Font chunks accept only a font name and byte offset');
  const { font, offset } = args;
  if (font !== 'Regular' && font !== 'Medium' && font !== 'Semibold')
    throwIpcError('INVALID_PARAMS', 'Unknown bundled font');
  const asset = FONT_ASSETS[font]; const manifest = FONT_MANIFEST[font];
  if (asset.size !== manifest.size || asset.sha256 !== manifest.sha256 || asset.data.length !== Math.ceil(asset.size / 3) * 4)
    throwIpcError('ASSET_CORRUPT', 'The bundled font does not match its build manifest');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= asset.size || offset % FONT_CHUNK_BYTES !== 0)
    throwIpcError('INVALID_PARAMS', 'Font offset must be a valid fixed chunk boundary');
  const end = Math.min(offset + FONT_CHUNK_BYTES, asset.size);
  // The fixed chunk size is divisible by three, so base64 slices remain independently decodable.
  const data = asset.data.slice(offset / 3 * 4, Math.ceil(end / 3) * 4);
  return { font, offset, totalBytes: asset.size, sha256: asset.sha256, data, nextOffset: end < asset.size ? end : null };
}
