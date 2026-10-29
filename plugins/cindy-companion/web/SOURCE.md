# Cindy settings source provenance

Upstream: https://github.com/makecindy/cindy
Commit: `118767c987f518286ae10a506a54287c3dc2a560`

This is an extraction of the original settings, teammate catalog and selected group surfaces, not the whole Cindy desktop application. `import-upstream.mjs` reproduces the copied components from a checkout at the pinned commit; host adapters under `web/` are maintained locally. SHA-256 below identifies the original file before any listed adapter modification.

## Source changes

- `BotsHomeView.tsx`: only its original `BotSettings` component and required imports are retained; the Projects child is excluded from the user-selected surface.
- `BotSettingsDrawer.tsx`: host close requests enter the original route blocker and save/leave guard.
- `BotAvatar.tsx`: accepts validated data image URLs from the local Paseo avatar store.
- `confirm-dialog-provider.tsx` and `speechVoiceLabelCache.ts`: transient cache uses frame memory because the sandbox has an opaque origin.
- `CompanionVoiceSettings.tsx`: adds an explicit unavailable-service notice; original voice state, controls and error UI remain.
- `BotChannelsPage.tsx`: no IM API means an explicit disconnected notice and disabled Add button; original full page/dialog source remains.
- Global provider/tool setup buttons retain the drawer and report that their external settings entry is not connected, rather than closing into a missing desktop route.
- Resource import paths and Tailwind content roots are relocated. Device/store/model/i18n/Electron seams are listed in `aliases.json` and implemented under `adapters/`.

## License and non-code material boundary

`LICENSE-CINDY` and `NOTICE-CINDY` preserve the upstream Apache-2.0 source-code license and XD Inc. attribution. The upstream README explicitly says model weights, datasets, prompts, trademarks and other separately identified materials are not automatically covered by the repository-level grant. This extraction does not claim blanket Apache licensing for non-code assets or trademark rights.

The three copied portrait image files below are unmodified public repository resources, not portraits or memories taken from the installed user account. No separate image license was identified alongside those files. Their repository provenance is recorded; no new license is asserted. Cindy glyph artwork rendered as JSX remains in the original `BotAvatar.tsx`.

The bundle uses `@fontsource-variable/inter@5.2.8` and `@fontsource-variable/jetbrains-mono@5.2.8` with their shipped OFL licenses. HarmonyOS Sans SC uses Huawei’s official original Regular, Medium and Semibold TTF files without conversion or subsetting. Copyright 2021-2025 Huawei Device Co., Ltd. All Rights Reserved. The complete agreement accompanies the fonts. [Source hashes](assets/fonts/SOURCE.json) and [supplemental provenance](licenses/SUPPLEMENTAL-SOURCES.md) distinguish the official ZIP from the separately obtained OpenHarmony agreement. Fonts remain in server-only immutable assets, transferred through bounded RPC chunks and SHA-256 verified before FontFace loads them. Gzip compresses the HTML without the HarmonyOS payloads; Inter and JetBrains Mono remain embedded.

Bundled npm notices: `licenses/THIRD-PARTY.md`. Font/image SHA-256 inventory: `asset-files.json`. Dependency versions and integrity values: `package-lock.json`.

## Copied files

| Original path | Local path (plugin-relative) | Original SHA-256 | Modified |
| --- | --- | --- | --- |
| `apps/desktop/src/renderer/assets/bot-presets/cindy.png` | `vendor/renderer/assets/bot-presets/cindy.png` | `12923c15beac4d20e2e12135e71cd2054e99c7aa3327645f0e042373e631dbcd` | no |
| `apps/desktop/src/renderer/components/chat/lightboxGestures.ts` | `vendor/renderer/components/chat/lightboxGestures.ts` | `669f71302e87fe6c2134e1b82ec2f6cf1f88a55e61f4a3768342fdc5af168c68` | no |
| `apps/desktop/src/renderer/components/layout/windowDrag.tsx` | `vendor/renderer/components/layout/windowDrag.tsx` | `c017f33f0fede97c386c00d27b28b37d7c5f100c655593d69331c7b37eaa610d` | no |
| `apps/desktop/src/renderer/components/new-chat/FastModeToggle.tsx` | `vendor/renderer/components/new-chat/FastModeToggle.tsx` | `8220b556167429f90632a26a1ebd79c1a05433b8f6969ddf2d95605e5e435902` | no |
| `apps/desktop/src/renderer/components/settings/AvatarCropEditor.tsx` | `vendor/renderer/components/settings/AvatarCropEditor.tsx` | `83f86be97b69cd99e784f6247c9578a1be1ddbca42570bc462b2ff56639daf00` | no |
| `apps/desktop/src/renderer/components/settings/avatarCropGeometry.ts` | `vendor/renderer/components/settings/avatarCropGeometry.ts` | `86e5459103d007e00d948577bd28d44141346df31e64a79d6dccfd1bcd295cee` | no |
| `apps/desktop/src/renderer/components/settings/avatarCropImage.ts` | `vendor/renderer/components/settings/avatarCropImage.ts` | `d3769519ec114f9d901f09ab3760216e4a51904db79f3e5a4830057b20d3eca9` | no |
| `apps/desktop/src/renderer/components/settings/DefaultOverrideControls.tsx` | `vendor/renderer/components/settings/DefaultOverrideControls.tsx` | `208b71323d5ca6c9380e08e2dd7e25cfbab6d1a2f809f2b08c2d2a651aabf950` | no |
| `apps/desktop/src/renderer/components/settings/settingsRowClasses.ts` | `vendor/renderer/components/settings/settingsRowClasses.ts` | `aeb9b02c0757221e71a2f9016693df46856c6e4fc33a422553dcc0f01a462df8` | no |
| `apps/desktop/src/renderer/components/sidebar/AttentionDot.tsx` | `vendor/renderer/components/sidebar/AttentionDot.tsx` | `4b65edd8cd837fa22aebb353fea4121e8de3b384a24298b0f1aae64e5b2b91e0` | no |
| `apps/desktop/src/renderer/components/title-bar/ChromeIconButton.tsx` | `vendor/renderer/components/title-bar/ChromeIconButton.tsx` | `58d2fc7c78a82325065eddbaba79648ced9281c2d6f0124252baab827ddaab3d` | no |
| `apps/desktop/src/renderer/components/ui/button.css` | `vendor/renderer/components/ui/button.css` | `5a04cbf8736729782de3dc19e2ad545853edd3bf412cccc5aa176d8dd896b1ea` | no |
| `apps/desktop/src/renderer/components/ui/button.tsx` | `vendor/renderer/components/ui/button.tsx` | `7f9385f4e2e29b6bc64f8bc3ca402f5c3a0db34c2ac3babd0d351fad076ea73c` | no |
| `apps/desktop/src/renderer/components/ui/collapse.tsx` | `vendor/renderer/components/ui/collapse.tsx` | `2f6172ce23ce87abcc2e23a78f4f1e5304b38fcaf822987aeb806e36bc15257c` | no |
| `apps/desktop/src/renderer/components/ui/confirm-dialog-provider.tsx` | `vendor/renderer/components/ui/confirm-dialog-provider.tsx` | `73cd6fe6771804d9d0476a537e2558f6d34f27ef3c00c5018a9c92996a07167d` | yes |
| `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx` | `vendor/renderer/components/ui/confirm-dialog.tsx` | `2729c21839a654776a0b483036eaa60711a6f89e1f29428bc547412a0af42f47` | no |
| `apps/desktop/src/renderer/components/ui/dropdown-menu-highlight.ts` | `vendor/renderer/components/ui/dropdown-menu-highlight.ts` | `7eda0a2cc2bb73724c15c7b94f3d4950222abcd46cbf1e32e4e41a549d11f757` | no |
| `apps/desktop/src/renderer/components/ui/dropdown-menu.tsx` | `vendor/renderer/components/ui/dropdown-menu.tsx` | `e921b424d5972174fe42e0c96c6bc6f9e4756608951dd40c2ac81a8d063cc58a` | no |
| `apps/desktop/src/renderer/components/ui/effort-slider.tsx` | `vendor/renderer/components/ui/effort-slider.tsx` | `a6d1584f1b3985237fb172f68787b44a40a5791dc96ea4a91a91d70516c206db` | no |
| `apps/desktop/src/renderer/components/ui/form-field.tsx` | `vendor/renderer/components/ui/form-field.tsx` | `cd42659f49ecb9baea4940682331648aaf6922fdf725eb04ba1816c7560e7bbc` | no |
| `apps/desktop/src/renderer/components/ui/input.tsx` | `vendor/renderer/components/ui/input.tsx` | `cf91d99c589ef0f845d0ded9a4ae3480223ad48d83ad0d2e6f99eafbc803f6a2` | no |
| `apps/desktop/src/renderer/components/ui/menu-row.tsx` | `vendor/renderer/components/ui/menu-row.tsx` | `a1986c03deca14923a1d9ab46a03dad548a8f3e2c0701fdecdb1eefe7e7a6dd4` | no |
| `apps/desktop/src/renderer/components/ui/popover.tsx` | `vendor/renderer/components/ui/popover.tsx` | `dbd6f2255130d819f24a6e918a2f075eb731bc9227fef47bfc18ddc2fdc121dd` | no |
| `apps/desktop/src/renderer/components/ui/segmented-control.css` | `vendor/renderer/components/ui/segmented-control.css` | `74101f41eb20c09b279f2ff94055981227f13a62527ff2a67b64a363f61c39b1` | no |
| `apps/desktop/src/renderer/components/ui/segmented-control.tsx` | `vendor/renderer/components/ui/segmented-control.tsx` | `7616ffd9e9e9f25c4c923a5cff34672c4bd3bcabea1874a6edb592b5b1aee5f7` | no |
| `apps/desktop/src/renderer/components/ui/select-parts.tsx` | `vendor/renderer/components/ui/select-parts.tsx` | `04b0878a6688abc8b4b48330d3ef081578d48c3cc4b29041614d983386b567c2` | no |
| `apps/desktop/src/renderer/components/ui/select.css` | `vendor/renderer/components/ui/select.css` | `8bf2dd958055dc4abcf3503771fd029f23651ad8c177216b4116b3e6d13bd032` | no |
| `apps/desktop/src/renderer/components/ui/select.tsx` | `vendor/renderer/components/ui/select.tsx` | `8ed8db8bb4c71f387e04bc324c01d9dd2a7262d0221c71e35401f64bf438186d` | no |
| `apps/desktop/src/renderer/components/ui/slider.css` | `vendor/renderer/components/ui/slider.css` | `5eb612888f24a0eb4c7803428ad0fcbba850dc23756bd2a428f1bce5fe1af9d6` | no |
| `apps/desktop/src/renderer/components/ui/slider.tsx` | `vendor/renderer/components/ui/slider.tsx` | `1f28339f70754ba7228793dc9f6d49f5167b6a4d523c96fee49048135de9bfae` | no |
| `apps/desktop/src/renderer/components/ui/spinner.tsx` | `vendor/renderer/components/ui/spinner.tsx` | `0ae44d7c23ecbf686bcb2d196eef8f2554a36609143c0cc8bf46504544ac0652` | no |
| `apps/desktop/src/renderer/components/ui/switch.css` | `vendor/renderer/components/ui/switch.css` | `ecd2a6a69c9435a5df9df0c76e99286b3aa8fbf1d444a0a4cafeeec071b234b5` | no |
| `apps/desktop/src/renderer/components/ui/switch.tsx` | `vendor/renderer/components/ui/switch.tsx` | `02702af8a7b9d7d53173e5a9212e58ff02ee07de968385e83b383213bcdb07a2` | no |
| `apps/desktop/src/renderer/components/ui/toast/DownloadToast.tsx` | `vendor/renderer/components/ui/toast/DownloadToast.tsx` | `4a43b33c3d31b41221651afec72d3d8b1c99ae2c0b576dc37be2225d7de296fd` | no |
| `apps/desktop/src/renderer/components/ui/toast/index.ts` | `vendor/renderer/components/ui/toast/index.ts` | `d56c3197ec7e9e5d953223abadc3c9a3b30fa304f73c8db999cbbd728c450817` | no |
| `apps/desktop/src/renderer/components/ui/toast/Toast.tsx` | `vendor/renderer/components/ui/toast/Toast.tsx` | `a85e9eefa4b840dc1728e278ae7ed9da39437120c712c8f829256bb8e096ee58` | no |
| `apps/desktop/src/renderer/components/ui/toast/ToastContainer.tsx` | `vendor/renderer/components/ui/toast/ToastContainer.tsx` | `d1439eb8ffcbc6f8c54af5572810b7493b0dff6e5a92ca7014db66d1f6bc757c` | no |
| `apps/desktop/src/renderer/components/ui/tooltip.tsx` | `vendor/renderer/components/ui/tooltip.tsx` | `0cd4e5534883e6953c8d63abb4dd5627738439b5c77fefb6ace18dffba7457cc` | no |
| `apps/desktop/src/renderer/contexts/dataOwnerGeneration.ts` | `vendor/renderer/contexts/dataOwnerGeneration.ts` | `15e88ab3ea89f0a5cbd4a1fa7c419e66f456f9909f8f4902fdde646e5910c174` | no |
| `apps/desktop/src/renderer/features/bots/BotAutonomySettings.tsx` | `vendor/renderer/features/bots/BotAutonomySettings.tsx` | `7a4f301206c5837b9ad0944d2e5bce723ed579807b3284d6390ce8dbe9a4ba9b` | no |
| `apps/desktop/src/renderer/features/bots/BotAvatar.tsx` | `vendor/renderer/features/bots/BotAvatar.tsx` | `0880c291caaf64b013c5e593497b585d3bdc83fc02f04751d61ad63751ab24bf` | yes |
| `apps/desktop/src/renderer/features/bots/botAvatarIdentity.ts` | `vendor/renderer/features/bots/botAvatarIdentity.ts` | `3d0d47f2c9b3d6076164f9a354f47e97bf007de2b600016bd106a750cf0b0b71` | no |
| `apps/desktop/src/renderer/features/bots/BotBasicProfileFields.tsx` | `vendor/renderer/features/bots/BotBasicProfileFields.tsx` | `376fe6b96d766209f134504f63c398679f79d159a8e534a0db489148dbeb1e19` | no |
| `apps/desktop/src/renderer/features/bots/BotCapabilitySettings.tsx` | `vendor/renderer/features/bots/BotCapabilitySettings.tsx` | `2331d626e4371654792981bcad3785236e36cada6bdb4c69db62f3b867a183e1` | no |
| `apps/desktop/src/renderer/features/bots/BotChannelsPage.tsx` | `vendor/renderer/features/bots/BotChannelsPage.tsx` | `a4523ebe647bdb0aad9b3dfc1ae74048acc736273f78ba388a78806c7312bf10` | yes |
| `apps/desktop/src/renderer/features/bots/BotDeleteDialog.tsx` | `vendor/renderer/features/bots/BotDeleteDialog.tsx` | `7df0d1bc746da750e40e646d1fcf5791f237cee55956a4e753eb3add45fafa5a` | no |
| `apps/desktop/src/renderer/features/bots/botGroupLane.ts` | `vendor/renderer/features/bots/botGroupLane.ts` | `e67bc2a780e06904115734aae0d61e5ccbd779a58a212b6291d63aa162473cba` | no |
| `apps/desktop/src/renderer/features/bots/botImConnectionClient.ts` | `vendor/renderer/features/bots/botImConnectionClient.ts` | `c9c2360c996e2a79c2f361721a9c27aed3406a7d05c26e57f2099eff7b33aa68` | no |
| `apps/desktop/src/renderer/features/bots/BotInvitationWelcome.tsx` | `vendor/renderer/features/bots/BotInvitationWelcome.tsx` | `0dc93718371dfabac5e3dc61cef53c40fe4f93df0defe45c8823f8fb7c7ed7f7` | no |
| `apps/desktop/src/renderer/features/bots/BotLifecycleSettings.tsx` | `vendor/renderer/features/bots/BotLifecycleSettings.tsx` | `52b17964d2ed38321c0bdba1f4e538481cedba5b77ea62b6574164882410262d` | no |
| `apps/desktop/src/renderer/features/bots/BotMemorySettings.tsx` | `vendor/renderer/features/bots/BotMemorySettings.tsx` | `b0640cdc162601ed72a33aa9c82716842f24e191cbca80186d5a3bc54d153f2b` | no |
| `apps/desktop/src/renderer/features/bots/BotModelChainEditor.tsx` | `vendor/renderer/features/bots/BotModelChainEditor.tsx` | `789f63c1eedf1232566e7422ead041c0d55e142419b97150a0ee45f45e9972bb` | no |
| `apps/desktop/src/renderer/features/bots/BotNightlyLearning.tsx` | `vendor/renderer/features/bots/BotNightlyLearning.tsx` | `93d18a32b4baaa2a1b1e3cf08ea4853fc381feabf824a956330484013eb38679` | no |
| `apps/desktop/src/renderer/features/bots/BotPortraitPicker.tsx` | `vendor/renderer/features/bots/BotPortraitPicker.tsx` | `9b459c146602f916cd083c7b333c0036add46843634da2e47bd0f0b264bd4e11` | yes |
| `apps/desktop/src/renderer/features/bots/botPronounContext.tsx` | `vendor/renderer/features/bots/botPronounContext.tsx` | `3eff8fefc2315b6d25417b1b05dfabcf30e7d5149d8662ead67f32922ce2d9da` | no |
| `apps/desktop/src/renderer/features/bots/BotRoutines.tsx` | `vendor/renderer/features/bots/BotRoutines.tsx` | `1a53c691cbd0ca07a4fa8758c8d341b56d56c8f17a3abf8726db98edd2a5e72f` | no |
| `apps/desktop/src/renderer/features/bots/botSettingsAutosave.ts` | `vendor/renderer/features/bots/botSettingsAutosave.ts` | `f9e6fafec648d889557fcb83eb4ee17989ea4f6e21a7bceb9a97fbb190d5a982` | no |
| `apps/desktop/src/renderer/features/bots/BotSettingsDrawer.tsx` | `vendor/renderer/features/bots/BotSettingsDrawer.tsx` | `d57c4ddf10c23b99da1e43e7f9865acded0d19ef99f6923144e907d2450daaa9` | yes |
| `apps/desktop/src/renderer/features/bots/botSettingsIcons.ts` | `vendor/renderer/features/bots/botSettingsIcons.ts` | `a6994054abefbf04862d4503bbfc7f76b75857ca43c86f32a5b3139bb53363f4` | no |
| `apps/desktop/src/renderer/features/bots/botSettingsTarget.ts` | `vendor/renderer/features/bots/botSettingsTarget.ts` | `fbbbd1d56a922791944e6d9864e0b990fb71b73a0ca4dd939135c2c71179d4fd` | no |
| `apps/desktop/src/renderer/features/bots/BotsHomeView.tsx` | `vendor/renderer/features/bots/BotsHomeView.tsx` | `7cfca17e5e6528346809f0d769e2837c4e834cf27f1350ba37d1511a90a7e291` | yes |
| `apps/desktop/src/renderer/features/bots/BotTaskModelEditor.tsx` | `vendor/renderer/features/bots/BotTaskModelEditor.tsx` | `f388e5b868a5241333ad718ab17fa91ef34aa38defe632e29c747b2784d056d7` | no |
| `apps/desktop/src/renderer/features/bots/useBotSettingsAutosave.ts` | `vendor/renderer/features/bots/useBotSettingsAutosave.ts` | `781bf697c45ebed0f3ea123e37258e965f73c4fd4007fa4380c05e8c5739c42d` | no |
| `apps/desktop/src/renderer/features/bots/voice/CompanionVoiceSettings.tsx` | `vendor/renderer/features/bots/voice/CompanionVoiceSettings.tsx` | `23e3aaefe14db293b3960e74c365ab6d7a6295a14eb6d9b9825496365012a308` | yes |
| `apps/desktop/src/renderer/features/bots/voice/PcmSpeechPlayer.ts` | `vendor/renderer/features/bots/voice/PcmSpeechPlayer.ts` | `e1e272c8e5bd576aa9df2ee6ba1569e87933d53e7391522576705d21932824de` | no |
| `apps/desktop/src/renderer/features/bots/voice/speechVoiceLabelCache.ts` | `vendor/renderer/features/bots/voice/speechVoiceLabelCache.ts` | `b13454d9f1fc32df195347fb0f88c4c78914ba234c677f4d30a5fcb0738d3d28` | yes |
| `apps/desktop/src/renderer/features/bots/voice/SpeechVoiceMenu.tsx` | `vendor/renderer/features/bots/voice/SpeechVoiceMenu.tsx` | `ac9182b87bc2ca84b245ac276a67dc02aa40ad75a3055de8a302efbc56a064b7` | no |
| `apps/desktop/src/renderer/features/bots/voice/SpeechVoicePicker.tsx` | `vendor/renderer/features/bots/voice/SpeechVoicePicker.tsx` | `44d42821e2585ef3f2cc5da47cdd0127f7039ab653e384eadfa6b8bd04789067` | no |
| `apps/desktop/src/renderer/features/bots/voice/voiceConfiguration.ts` | `vendor/renderer/features/bots/voice/voiceConfiguration.ts` | `a9f362f145d4faa38b851545036ee42373484dee712d74f7ebab5414e9813903` | no |
| `apps/desktop/src/renderer/features/bots/voice/VoicePreviewController.ts` | `vendor/renderer/features/bots/voice/VoicePreviewController.ts` | `ba6e62a12d62eadd7b7e18c086ce711e4ccc7e26fef461216ef27c8722f6e29f` | no |
| `apps/desktop/src/renderer/features/scheduler/lib/cronCodexPreset.ts` | `vendor/renderer/features/scheduler/lib/cronCodexPreset.ts` | `9718aa1c9fc3c3c897403b6573bc2238f69906e83ea5922962a2a7d0c42feed9` | no |
| `apps/desktop/src/renderer/features/scheduler/lib/cronToHuman.ts` | `vendor/renderer/features/scheduler/lib/cronToHuman.ts` | `409516d00c0d66acb563e127e08710a5f151b5c7a1b2d31c00c12f79d298f300` | no |
| `apps/desktop/src/renderer/hooks/useReducedMotion.ts` | `vendor/renderer/hooks/useReducedMotion.ts` | `965220bcd957d7d114075c18e6683b7c3aa2f52f2828ae2914d801ff44018c1f` | no |
| `apps/desktop/src/renderer/hooks/useRelativeTime.ts` | `vendor/renderer/hooks/useRelativeTime.ts` | `df7f0199e764ba86ecb738c9fd2cb9ee6fb747195cb587402bb682518365d33d` | no |
| `apps/desktop/src/renderer/i18n/locales/en/common.json` | `vendor/renderer/i18n/locales/en/common.json` | `c16f96d7e8c823e2343c8df695ac3ac71545e47953d4c488353b55436caa6ea4` | no |
| `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json` | `vendor/renderer/i18n/locales/zh-CN/common.json` | `d06f18254fadfc33d372eb7904213d31e494fe8045c4dc13619479f8ef54f387` | no |
| `apps/desktop/src/renderer/lib/fileTransferToasts.ts` | `vendor/renderer/lib/fileTransferToasts.ts` | `ce0704d6a872d056f56dd3ce92da2f0541d879f7674c2d20273181af26ae9b63` | no |
| `apps/desktop/src/renderer/lib/scrollbarAutoHide.ts` | `vendor/renderer/lib/scrollbarAutoHide.ts` | `c87786bf9dd31c344f15c795f5cec6af2b215cb4abb0bd0b019629051cb04b25` | no |
| `apps/desktop/src/renderer/lib/toast.ts` | `vendor/renderer/lib/toast.ts` | `d43e37f62d030abf42da821d7cbc93ecc95e39c8896b9a85f49c2a52578aa01a` | no |
| `apps/desktop/src/renderer/lib/utils.ts` | `vendor/renderer/lib/utils.ts` | `d289d7563882e40b09850b4c86fb8a4e4c758fa16d81fc1425aba3277b1773f8` | no |
| `apps/desktop/src/renderer/styles/generated/token-mappings.ts` | `vendor/renderer/styles/generated/token-mappings.ts` | `4633457cf945677ad1bc8bafd190fe1cb2cea2acbbe939711aa0cfe90a1426a3` | no |
| `apps/desktop/src/renderer/styles/generated/tokens.css` | `vendor/renderer/styles/generated/tokens.css` | `a1c8d401f4e7161b07b1484aa394cd9648626143d53bb51d4f36e455f21413fb` | no |
| `apps/desktop/src/renderer/styles/globals.css` | `vendor/renderer/styles/globals.css` | `417cfe9b798125611351f4b80a1774db91979c11dfe79c2e251fbc2dfcf6e24d` | yes |
| `apps/desktop/src/renderer/themes/builtin/default-dark.ts` | `vendor/renderer/themes/builtin/default-dark.ts` | `4624c2d4ef76b76415e043b4da9cd56fee0a68f3902d17e4fb5a74b5da4a0a43` | no |
| `apps/desktop/src/renderer/themes/builtin/default-light.ts` | `vendor/renderer/themes/builtin/default-light.ts` | `4260f8cd2c2a90cae886ee71068f445704636d1f31aa2103f988a8f4a1e8bf04` | no |
| `apps/desktop/src/renderer/themes/color-registry.ts` | `vendor/renderer/themes/color-registry.ts` | `0be9b44d24fa86502f8329b389463034af9c4d2c2016b58a5464036988d55933` | no |
| `apps/desktop/src/renderer/themes/colors.ts` | `vendor/renderer/themes/colors.ts` | `479a7cf32ea6c9bf4715cfff912139aec735554c01599007f754e917c2b4b87f` | no |
| `apps/desktop/src/renderer/themes/effortTierColors.ts` | `vendor/renderer/themes/effortTierColors.ts` | `98c765560973f34091dc3c209ae40c0535a51c5fa72770b7034746ddb65d6de5` | no |
| `apps/desktop/src/renderer/themes/event.ts` | `vendor/renderer/themes/event.ts` | `77538148b6221eab748bdfd549d60e40ed45761dc1ef832b30cbf5a2ab4efab9` | no |
| `apps/desktop/src/renderer/themes/theme-service.ts` | `vendor/renderer/themes/theme-service.ts` | `ece3aeb31b7c19e82960eda8d7a1e9b4a7f83b67c678ae7d913a62a594161289` | no |
| `apps/desktop/src/renderer/utils/ipcError.ts` | `vendor/renderer/utils/ipcError.ts` | `194496d855797d86b2d0acf73f6bc350589763ab26b1d7b6892167718f016a5d` | no |
| `apps/desktop/src/shared/alibabaSpeechVoices.ts` | `vendor/shared/alibabaSpeechVoices.ts` | `5638ddfb01312c61e3a37087e76bd992516dee9936384d52f2b8ade2609396c3` | no |
| `apps/desktop/src/shared/botAvatarHue.ts` | `vendor/shared/botAvatarHue.ts` | `17ae349c46691603c07dc0c365d959374d62e54275986b1eb99a562a39e6cf42` | no |
| `apps/desktop/src/shared/botAvatarValue.ts` | `vendor/shared/botAvatarValue.ts` | `73762251dc1355fd58df7908567925efbb877e906119e66fb4e7922427d873ee` | no |
| `apps/desktop/src/shared/botCapabilitySelection.ts` | `vendor/shared/botCapabilitySelection.ts` | `1e200e6bf583179a80dde5c0e91f53a044d694794d3a272ed08bd00967b10cc2` | no |
| `apps/desktop/src/shared/botCreation.ts` | `vendor/shared/botCreation.ts` | `9bc659e66ec46ac7391d58ff6c00c50553de24a3745792b71aed3e482bf59393` | no |
| `apps/desktop/src/shared/botGender.ts` | `vendor/shared/botGender.ts` | `4f297bd2a1d579a39e8a4a743934b54b7b1b908e53ece79792b77e220fe5ebbe` | no |
| `apps/desktop/src/shared/botMemory.ts` | `vendor/shared/botMemory.ts` | `1aca08db9f9234e14e6e2ffb7d8f97d1938fb9d204f311fbe4016d7ff2b28afc` | no |
| `apps/desktop/src/shared/botModelChain.ts` | `vendor/shared/botModelChain.ts` | `20a1cf741928cd53a5999e480982e8338f8dc7e01bbdc09fe31cd95d47b98cfa` | no |
| `apps/desktop/src/shared/dataOwnerPush.ts` | `vendor/shared/dataOwnerPush.ts` | `d5fd214771e7f86cbb60eca9d26a889c64e084786f634a345d23b77312532023` | no |
| `apps/desktop/src/shared/featureRetirements.ts` | `vendor/shared/featureRetirements.ts` | `0ea26b4394ae11ce1d302882ee622082f0b17d9cf082fb04cedd1569a7d019f5` | no |
| `apps/desktop/src/shared/ipc-errors.ts` | `vendor/shared/ipc-errors.ts` | `2a14d6f1ae7ed55097a0ca4e32f527bfcff53e3d7713d4f4edaf92688fc93ae5` | no |
| `apps/desktop/src/shared/ipcError.ts` | `vendor/shared/ipcError.ts` | `912176dfec21b00f2b536b1bc4438103643124e57cced593595eaf6fee65ad21` | no |
| `apps/desktop/src/shared/openPathResult.ts` | `vendor/shared/openPathResult.ts` | `c25432c60ee49b481ddd95f89395231816aabfb1d4577a09511235e4ca8c98f1` | no |
| `apps/desktop/src/shared/pluginContributionContract.ts` | `vendor/shared/pluginContributionContract.ts` | `a25b7590a7800f4d4df01b85601915fcd26467a6e9cb82696cfd4a7be438b20f` | no |
| `apps/desktop/src/shared/remoteMediaUrl.ts` | `vendor/shared/remoteMediaUrl.ts` | `ee508890f83ecf1de8732727975ae734e18fc5c3e030ea118f06d345f2ca2897` | no |
| `apps/desktop/src/shared/speechProtocols.ts` | `vendor/shared/speechProtocols.ts` | `55fecdc2015068f529fcae64f57b3444ecc313965b69f461690c773f5eab1c12` | no |
| `apps/desktop/src/shared/speechVoices.ts` | `vendor/shared/speechVoices.ts` | `6186466648c8ab28fa55192c84e9c052cdaa69613105675aa8a3a5edbe7945f1` | no |
| `packages/maker-scheduler/src/engine/cron.ts` | `vendor/shared/upstream/cron.ts` | `a2f67a030c477e16468e7cbf109b7347a6500f29e9d2bd1065aa39b2f3496da2` | no |
| `packages/maker-shared/src/modelRoute.ts` | `vendor/shared/upstream/modelRoute.ts` | `c2f006a6e113bc8f58abe344bdea028f4e0a295a47761007699c2638148b899b` | no |
| `packages/maker-shared/src/scheduleForm.ts` | `vendor/shared/upstream/scheduleInterval.ts` | `7988f97a317355782dd8e5e26b0ba542bbc8357c292b89211030a94f7f21e778` | yes |
| `apps/desktop/src/shared/voiceConversation.ts` | `vendor/shared/voiceConversation.ts` | `1a72d9bac70a63c78dd6f67aa5e5a68f37509923997a08c5daac56356c477fe3` | no |
| `apps/desktop/resources/legacy-teammate-avatars/dash.png` | `web/assets/legacy-teammate-avatars/dash.png` | `84360ff6981153c097b267675066dd3bb54f82d1eaf7a8280dc4a72bf0d7d9d7` | no |
| `apps/desktop/resources/legacy-teammate-avatars/lizi.png` | `web/assets/legacy-teammate-avatars/lizi.png` | `3cfec87963fa30d5faefa9986e78bfc7821c1d970f4f2061b1380f546de462f6` | no |
| `apps/desktop/resources/teammate-portrait-gallery.png` | `web/assets/teammate-portrait-gallery.png` | `6d23a43a460769194f5f449fa0d4b43c69ce324f1e992bf7f484c8f1ac8acd17` | no |
| `apps/desktop/tailwind.config.ts` | `web/tailwind.config.ts` | `3ae0e4f2b6e69895a0ca884652ffd1983b9654facf64b8b8f2356ea40d91bab2` | yes |

`styles/globals.css` has one additional font adaptation: its four npm punctuation subset faces are removed, and the same fallback slot uses the complete original HarmonyOS Sans SC face loaded through verified font chunks. No subset/font conversion remains.

## Original preset catalog extension

`BotMarketDialog.tsx`, `BotMarketModules.tsx` and `botMarketDisplay.ts` are copied from the same pinned source. List/detail JSX, layout, tokens, item names, partial-save state and invitation semantics are retained. The dialog accepts an optional `onOpenBot` callback so the Paseo bridge opens the actual native companion session. Auth reads the iframe host scope, plugin names remain authored names without inventing installed status, and sidebar plugin icons use the original Plug icon. `web/upstream-files.json` includes the source hashes. Package bytes and the non-code rights evidence are documented in [`server/presets/SOURCE.md`](../server/presets/SOURCE.md).

## Original group surfaces and implementation boundary

[`group-upstream-files.json`](group-upstream-files.json) records the exact original hashes and extraction boundaries. `BotGroupCreateDialog`, `BotGroupAvatars`, `useBotGroupMentionPicker`, `botGroupComposerChrome`, `SendButton` and `botTimeline` retain the upstream implementation. The creation dialog adds the host close event and late-result guards. The pure mention parser and group contract re-exports point to the original shared modules already used by the server.

`group-chat.tsx` adapts the original header, date divider, message grouping/bubble JSX, avatar stack, composer and mention picker to the local Paseo group snapshot. `group-settings.tsx` adapts the original drawer header, name/member fields and reply-mode segmented control. These are extracts, not the full upstream group page: plans, threads, reactions, attachments, quote/share actions, cloud members, organizer/project-directory/speaking-mode controls and streaming tool cards are not currently implemented. They remain tracked in `CORE_FEATURES.md`, not represented by fake empty service responses.

Group creation and user messages retain their operation IDs across a failed acknowledgement. Reads are single-flight with bounded retry and stop on unmount. A stop receipt renders its actual returned round state; accepted is not treated as stopped. Settings close waits for the current save, preserves drafts after errors, and sends optimistic revisions. Permission requests open the actual native task identified by the host. Unit/component checks do not replace installed visual acceptance.

The composer follows the upstream `showStop = running && draft is empty` rule. During a discussion, an explicit mention may enqueue an independent reply; its receipt appears in the pending queue and does not replace the active speaker/Stop target. A supplementary message with deferred delivery is labeled explicitly: the host has recorded it for later speakers and has not confirmed delivery to the current speaker. That notice clears only when a subsequent host snapshot records actual delivery.

## Original custom teammate creation

`BotRosterView.tsx` retains the original 520px dialog, name field, random initial portrait, full 17-portrait picker/upload crop, first-model selection and original duplicate-name validation. The original creation page has no description field: it sends an empty description, later editable in Profile. `transform-roster.mjs` reproduces the host close, data-owner, portrait-preparation and asynchronous navigation guards. The external import button stays in its authored position but is disabled with an explicit unavailable-service label; the providers detour reports the unconnected host settings entry. Neither action fabricates an imported teammate or a provider connection.

The bridge sends `{operationId,name,description,avatarImageBase64?,capabilities?:{modelChainOverride}}` to `profile.create`, preserving the same intent on retry. It checks for an actual usable inherited or explicit model and waits for the committed profile before opening the native conversation. Portrait bytes and the model override belong to the same host creation transaction. Original gallery/license provenance is unchanged.
