// Playback is unavailable without host permission state; fail closed until voice is connected.
export const EMPTY_LIGHT_STATE = Object.freeze({ queuePaused: true });
export const makerChatStore = { subscribeLight: () => () => {}, getLightSnapshot: () => EMPTY_LIGHT_STATE };
