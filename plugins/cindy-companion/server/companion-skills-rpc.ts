import type { CompanionSkillMutation } from '../shared/companion-skills';
import { string, throwIpcError } from './errors';

/** Only this whitelist reaches the owner-bound filesystem adapter. */
export function skillMutation(kind: CompanionSkillMutation['kind'], args: Record<string, unknown>): CompanionSkillMutation {
  const operationId = string(args.operationId, 'operationId', 200);
  const expectedRevision = args.expectedRevision;
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)))
    throwIpcError('INVALID_PARAMS', 'Read the skill first and supply its exact revision; use null only to create a new skill');
  if (kind === 'save') return { kind, operationId, expectedRevision, name: string(args.name, 'name', 256),
    description: string(args.description, 'description', 1120), body: string(args.body, 'body', 65536),
    ...(args.slug === undefined ? {} : { slug: string(args.slug, 'slug', 64) }) };
  const slug = string(args.slug, 'slug', 64);
  if (kind === 'source') return { kind, operationId, expectedRevision, slug, source: string(args.source, 'source', 1024 * 1024) };
  if (!expectedRevision) throwIpcError('INVALID_PARAMS', 'An existing skill revision is required');
  if (kind === 'delete') return { kind, operationId, expectedRevision, slug };
  if (kind === 'enabled' && typeof args.enabled === 'boolean') return { kind, operationId, expectedRevision, slug, enabled: args.enabled };
  throwIpcError('INVALID_PARAMS', 'Invalid skill operation');
}
