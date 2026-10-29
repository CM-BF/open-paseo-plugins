/** Cindy 118767c shared/botWorkbench.ts; references, not filesystem permissions. */
export interface BotLinkedProject { path: string; addedAt: string; deviceId?: string }
export interface BotProjectOption { id: string; name: string; path: string; deviceId?: string; linked: boolean; available: boolean }
export interface LinkedProjectsSnapshot { projects: BotProjectOption[]; revision: string }
