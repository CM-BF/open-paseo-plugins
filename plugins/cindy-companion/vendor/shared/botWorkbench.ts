// Extracted original linked-project types; unrelated workbench task logic is not included.
/** Project references provide context, never task responsibility or execution permission. */
export interface BotLinkedProject {
  path: string;
  addedAt: string;
  /** Missing means this computer; a foreign path must never be opened locally. */
  deviceId?: string;
}

export interface BotProjectOption {
  id: string;
  name: string;
  path: string;
  deviceId?: string;
  linked: boolean;
  available: boolean;
}
