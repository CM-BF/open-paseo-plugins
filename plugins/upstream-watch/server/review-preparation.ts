import type { State, Watch } from '../shared/contracts';
import type { TaskExecution } from './tasks';
import type { PreparedReviewSource, ReviewSource } from './review-source';
import { preparedSourceInstructions } from './review-source';
import { reviewKey } from './review-context';
import { normalizeRepository } from './validation';
function currentReview(task:TaskExecution,state:State,disposed:boolean):Watch {
  const current=state.watches.find(watch=>watch.id===task.watchId);
  if(disposed||!current?.enabled||current.error||!current.review||!current.baseline||!task.localRevision||
    (task.automatic&&(!state.settings.enabled||!current.review.autoReview))||
    current.workspaceId!==task.workspaceId||current.provider!==task.provider||reviewKey(current,task.localRevision)!==task.reviewKey)
    throw new Error('建议范围或启用状态在源码准备期间已变化，请重新检查。');
  return current;
}
/** Revalidate after slow source retrieval, before handing any prompt to a native agent. */
export async function prepareReviewPrompt(task: TaskExecution, deps: {
  prepare(source: ReviewSource, head: string): Promise<PreparedReviewSource>;
  state(): Promise<State>;
  disposed(): boolean;
  placement?():Promise<void>;
}): Promise<string> {
  if (task.intent !== 'review') return task.prompt;
  const current=currentReview(task,await deps.state(),deps.disposed());
  // Old journals can recover only while the entire original frozen scope still matches.
  const expected={repository:normalizeRepository(current.repository),baseline:current.baseline!};
  const frozen=task.reviewSource??expected;
  if(normalizeRepository(frozen.repository)!==expected.repository||frozen.baseline!==expected.baseline)throw new Error('固定上游源码记录与原建议范围不匹配。');
  const source=await deps.prepare(frozen,task.head);
  await deps.placement?.();
  currentReview(task,await deps.state(),deps.disposed());
  return task.prompt+preparedSourceInstructions(source);
}
