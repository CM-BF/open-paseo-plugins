import type { PluginClientContext, PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { TASK_CARD_KIND, taskCardSchema, type TaskCardData } from '../shared/task-card';
import { NativeCompanionTaskCard } from './task-card';
import { taskTransformer } from './task-transformer';

export function contributeTaskCards(client: PluginClientContext) {
  function Card(props: PluginTimelineItemProps<TaskCardData>) {
    return <NativeCompanionTaskCard {...props} onOpenAgent={agentId => client.openScreen({ screenId: 'conversation', params: { agentId } })}/>;
  }
  const removeRenderer = client.addTimelineRenderer({ kind: TASK_CARD_KIND, version: 1, schema: taskCardSchema, Component: Card });
  const removeTransformer = client.addTimelineTransformer(taskTransformer);
  return () => { removeTransformer(); removeRenderer(); };
}
