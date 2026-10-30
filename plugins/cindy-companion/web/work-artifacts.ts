import { invoke } from './bridge';
import type { OpenPlanArtifact } from './work-plan';

/** The host revalidates group/plan/step ownership and file containment before navigation. */
export const openWorkArtifact: OpenPlanArtifact = async (plan, position, path, messageId) => {
  await invoke('paseo.openWorkArtifact', { groupId: plan.groupId, planId: plan.id, position, path, ...(messageId ? { messageId } : {}) });
};
