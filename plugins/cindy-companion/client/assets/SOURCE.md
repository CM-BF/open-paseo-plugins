# Host avatar assets

Source: https://github.com/makecindy/cindy at `118767c987f518286ae10a506a54287c3dc2a560`. The data URLs contain the original PNG bytes without resizing or re-encoding. Only the three sentinels actually recognized by upstream `BotAvatar.tsx` are mapped; new gallery choices are already PNG data URLs after the original picker crops them.

| Preset | Original path | SHA-256 |
| --- | --- | --- |
| cindy | `apps/desktop/src/renderer/assets/bot-presets/cindy.png` | `12923c15beac4d20e2e12135e71cd2054e99c7aa3327645f0e042373e631dbcd` |
| dash | `apps/desktop/resources/legacy-teammate-avatars/dash.png` | `84360ff6981153c097b267675066dd3bb54f82d1eaf7a8280dc4a72bf0d7d9d7` |
| lizi | `apps/desktop/resources/legacy-teammate-avatars/lizi.png` | `3cfec87963fa30d5faefa9986e78bfc7821c1d970f4f2061b1380f546de462f6` |

Fallback hue and initial behavior reuses the original asset-free `shared/vendor/botAvatarHue.ts` and `botAvatarValue.ts`; see [their source manifest](../../shared/vendor/SOURCE.md). These copies live inside Paseo's permitted `shared/` module boundary; the separate `vendor/` tree belongs only to the iframe build. The light/dark hue palette comes from original `apps/desktop/src/renderer/themes/colors.ts` (`bot-avatar-*-bg`).

These are public repository assets, not data from a user account. Upstream source-code attribution is preserved by [LICENSE-CINDY](../../web/LICENSE-CINDY) and [NOTICE-CINDY](../../web/NOTICE-CINDY). No separate image license was found alongside these PNGs; this provenance does not assert blanket Apache licensing or trademark rights for non-code material. See [the slice source inventory](../../web/SOURCE.md).
