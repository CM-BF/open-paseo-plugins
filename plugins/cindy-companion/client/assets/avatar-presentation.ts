import { botAvatarInitial, normalizeBotAvatarHue, type BotAvatarHue } from "../../shared/vendor/botAvatarHue";
import { isSingleBotAvatarGrapheme } from "../../shared/vendor/botAvatarValue";
import { BUNDLED_AVATAR_BY_SENTINEL } from "./preset-avatars";

// Original Cindy registered bot-avatar-*-bg tokens, not CSS named colors. See SOURCE.md.
const HUES: Record<BotAvatarHue, { light: string; dark: string }> = {
  red: { light: "#f7ded9", dark: "#4a2e2a" },
  orange: { light: "#f9e3d2", dark: "#4a3527" },
  amber: { light: "#f6ebcd", dark: "#473a22" },
  green: { light: "#dceedd", dark: "#26402a" },
  teal: { light: "#d6ebea", dark: "#21403e" },
  blue: { light: "#dce6f5", dark: "#263449" },
  violet: { light: "#e3ddf3", dark: "#322b48" },
  pink: { light: "#f6deea", dark: "#452b39" },
  graphite: { light: "#e5e5e5", dark: "#3c3c3a" },
};
export function avatarPresentation(bot: { avatar?: string | null; avatarColor?: string | null; name?: string | null }, appearance: "dark" | "light") {
  const avatar = (bot.avatar ?? "").trim();
  const uri = BUNDLED_AVATAR_BY_SENTINEL[avatar.toLowerCase()] ??
    (/^data:image\/(?:png|jpeg|webp);base64,/i.test(avatar) ? avatar : null);
  const glyph = isSingleBotAvatarGrapheme(avatar) ? avatar : botAvatarInitial(bot.name);
  return { uri, glyph, backgroundColor: HUES[normalizeBotAvatarHue(bot.avatarColor)][appearance] };
}
