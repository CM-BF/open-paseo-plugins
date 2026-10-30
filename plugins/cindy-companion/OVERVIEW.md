# Cindy Companion

Cindy Companion brings Cindy's Teammates entry and original settings drawer to Paseo. Click an avatar to return to that teammate's persistent Paseo conversation, or open Settings to edit its profile, personality, avatar and local memory.

This plugin uses HarmonyOS Sans Fonts. Copyright 2021 Huawei Device Co., Ltd. The unmodified fonts are bundled under the [HarmonyOS Sans Fonts License Agreement](web/licenses/HarmonyOS-Sans-LICENSE_Fonts).

Each teammate keeps its own local identity and memory files. A local MCP connection lets its agent read current context and read or write the same memory shown in Settings. Routines create new task sessions through Paseo's scheduler.

Requires Paseo 0.13.2 or later and a configured agent provider. The original settings drawer runs on desktop and web; mobile can open teammate chats. Existing-session model and instruction updates depend on the accompanying Paseo API changes and remain visibly pending on older hosts.

This preview reuses Cindy's settings components with Paseo adapters. Voice and messaging services are disconnected, and routines currently support one time trigger with a new task session. Desktop and compact visual acceptance is still pending. Companion data stays on the connected Paseo host; the selected agent provider processes conversation and tool content under its usual settings.
