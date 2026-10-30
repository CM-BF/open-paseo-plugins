// The plugin backend returns fetchable data URLs; there is no Cindy cloud/media cache in this frame.
export type CompanionAvatarSource = { avatar: string; deviceId: string | null };
export function useCachedCompanionAvatar(source: CompanionAvatarSource | null) { return source?.avatar ?? null; }
