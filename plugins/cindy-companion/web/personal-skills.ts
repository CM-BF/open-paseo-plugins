import { useEffect, useRef, useState } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../vendor/renderer/contexts/dataOwnerGeneration';
import { invoke } from './bridge';

export interface PersonalSkillSummary {
  slug: string;
  name: string;
  description?: string;
  enabled?: boolean;
}
export interface PersonalSkillPage {
  skills: PersonalSkillSummary[];
  total: number;
  nextOffset?: number;
  revision?: string;
}
export interface PersonalCapabilityCatalog {
  personalSkills?: PersonalSkillPage;
  personalRuntime?: { status: 'pending'; reason: 'native-loading-unverified' };
  providerError?: { code: string; message: string };
}

/** Retain display fields only, never native paths from a mismatched host. */
function catalogChanged() { return Object.assign(new Error('The personal skill library changed. Reload this search from the beginning.'), { code: 'SKILL_CATALOG_CHANGED' }); }

export function personalSkillPage(value: unknown, offset = 0, expectedRevision?: string): PersonalSkillPage {
  const page = value as PersonalSkillPage | undefined;
  if (!page || !Array.isArray(page.skills) || !Number.isSafeInteger(page.total) || page.total < 0
    || offset + page.skills.length > page.total
    || (page.nextOffset !== undefined && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset >= page.total))
    || (page.nextOffset !== undefined && (!page.skills.length || page.nextOffset !== offset + page.skills.length))
    || (offset + page.skills.length < page.total && page.nextOffset === undefined)) throw new Error('The host returned an invalid personal skill page.');
  if (page.revision !== undefined && (typeof page.revision !== 'string' || !page.revision || page.revision.length > 128))
    throw new Error('The host returned an invalid personal skill catalog revision.');
  if (page.nextOffset !== undefined && !page.revision)
    throw new Error('This host cannot provide stable personal skill pagination. Update the host before loading the complete library.');
  if (expectedRevision !== undefined && page.revision !== expectedRevision) throw catalogChanged();
  const skills = page.skills.map(skill => {
    if (!skill || typeof skill.slug !== 'string' || !skill.slug || typeof skill.name !== 'string'
      || (skill.description !== undefined && typeof skill.description !== 'string')
      || (skill.enabled !== undefined && typeof skill.enabled !== 'boolean')) throw new Error('The host returned an invalid personal skill.');
    return { slug: skill.slug, name: skill.name, ...(skill.description !== undefined ? { description: skill.description } : {}),
      ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}) };
  });
  if (new Set(skills.map(skill => skill.slug)).size !== skills.length) throw catalogChanged();
  return { skills, total: page.total, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    ...(page.revision !== undefined ? { revision: page.revision } : {}) };
}

interface PageState { key: string; page?: PersonalSkillPage; busy: boolean; error?: string; retryOffset?: number; changed?: boolean }

/** Reuse the catalog's first page; search/continuation never reload native commands. */
export function usePersonalSkills({ botId, catalogKey, initial, query, open }: {
  botId: string; catalogKey: string; initial?: PersonalSkillPage; query: string; open: boolean;
}) {
  const owner = getDataOwnerGeneration();
  const search = query.trim();
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, botId, catalogKey, search, open]);
  const scope = useRef({ key, sequence: 0, pending: false });
  if (scope.current.key !== key) scope.current = { key, sequence: 0, pending: false };
  const [saved, setSaved] = useState<PageState>({ key: '', busy: false });
  const current: PageState = saved.key === key ? saved
    : { key, page: !search ? initial : undefined, busy: !!search && open && !!initial };
  const latest = useRef(current); latest.current = current;
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; scope.current.sequence++; }; }, []);

  const load = async (offset: number) => {
    const own = scope.current;
    if (!alive.current || !open || !initial || own.key !== key || own.pending || !isDataOwnerGenerationCurrent(owner)) return;
    const sequence = ++own.sequence;
    const before = latest.current.key === key ? latest.current.page : undefined;
    own.pending = true;
    const valid = () => alive.current && scope.current === own && own.sequence === sequence && isDataOwnerGenerationCurrent(owner);
    setSaved({ key, page: offset ? before : undefined, busy: true });
    try {
      const expectedRevision = offset ? before?.revision : undefined;
      const response = await invoke('skills.list', { botId, query: search, offset, limit: 50,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
      if (!valid()) return;
      const page = personalSkillPage(response, offset, expectedRevision);
      const skills = offset ? [...(before?.skills ?? []), ...page.skills] : page.skills;
      if (new Set(skills.map(skill => skill.slug)).size !== skills.length) throw catalogChanged();
      setSaved({ key, page: { ...page, skills }, busy: false });
    } catch (error) {
      const changed = (error as { code?: string } | undefined)?.code === 'SKILL_CATALOG_CHANGED';
      if (valid()) setSaved({ key, page: changed ? undefined : offset ? before : undefined, busy: false,
        error: error instanceof Error ? error.message : String(error), retryOffset: changed ? 0 : offset, changed });
    } finally { if (valid()) own.pending = false; }
  };

  useEffect(() => {
    const own = scope.current;
    if (open && initial && search) void load(0);
    return () => { own.sequence++; own.pending = false; };
  }, [key, initial]);

  return { ...current,
    more: () => { if (current.page?.nextOffset !== undefined) return load(current.page.nextOffset); },
    retry: () => load(current.retryOffset ?? 0),
  };
}
