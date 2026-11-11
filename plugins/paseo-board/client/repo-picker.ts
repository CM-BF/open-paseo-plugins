import type { GitHubRepository } from "../shared/release-contracts";

const SHOWN_REPOSITORIES = 100;

export interface RepositoryChoices { personal: GitHubRepository[]; others: GitHubRepository[]; hidden: number; noMatch: boolean }

/** Own repositories first. Typing filters the list; an exact pick keeps every option available to switch. */
export function repositoryChoices(list: GitHubRepository[], typed: string, limit = SHOWN_REPOSITORIES): RepositoryChoices {
  const query = typed.trim().toLowerCase();
  const matching = query && !list.some(item => item.name.toLowerCase() === query) ? list.filter(item => item.name.toLowerCase().includes(query)) : list;
  const personal = matching.filter(item => item.personal).slice(0, limit);
  const others = matching.filter(item => !item.personal).slice(0, limit - personal.length);
  return { personal, others, hidden: matching.length - personal.length - others.length, noMatch: list.length > 0 && matching.length === 0 };
}
