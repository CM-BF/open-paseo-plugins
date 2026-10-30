const cloud = Object.freeze({ enabled: false, actors: [], demotedBotIds: [] });
const empty: never[] = [];
export const useCompanionCloud = () => cloud;
export const useRemoteBots = () => empty;
export const cloudCompanionAt = () => null;
