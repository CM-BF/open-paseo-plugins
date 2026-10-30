import type { ComponentType } from 'react';
import type { PluginClientContext, PluginHostProps } from '@getpaseo/plugin/client';
import type { DmMessageSource } from '../shared/dm-conversation';
import type { DmQuoteSelection } from '../shared/dm-quotes';

/** Optional additive host API. The published 0.13 SDK does not declare these methods yet. */
export interface QuoteNavigation {
  locateMessage?(source: DmMessageSource): Promise<{ status: 'found' | 'not-found' | 'limit' | 'unavailable' }>;
}
export interface QuoteHostProps extends PluginHostProps { agentId: string; navigation?: QuoteNavigation }
export interface QuoteMessageProps extends QuoteHostProps {
  message: {
    reference: DmMessageSource['reference'];
    position: NonNullable<DmMessageSource['position']>;
    text: string;
    inputContexts?: readonly { pluginId: string; id: string; version: string; data: unknown }[];
  };
}
export interface QuoteComposerProps extends QuoteHostProps {
  workspaceId: string;
  context: Readonly<{ version: string; value: unknown }>;
  clear(expectedVersion: string): void;
  focusInput(): void;
}
export interface QuoteHost {
  addMessageAction(value: { id: string; Component: ComponentType<QuoteMessageProps> }): () => void;
  addMessagePrefix(value: { id: string; Component: ComponentType<QuoteMessageProps> }): () => void;
  addComposerContext(value: { id: string; Component: ComponentType<QuoteComposerProps> }): () => void;
  setComposerContext(input: { id: string; agentId: string; value: DmQuoteSelection; focus?: boolean }): Promise<{ version: string }>;
}
export function quoteHost(client: PluginClientContext): QuoteHost | null {
  const candidate: PluginClientContext & Partial<QuoteHost> = client;
  if (!candidate.addMessageAction || !candidate.addMessagePrefix || !candidate.addComposerContext || !candidate.setComposerContext) return null;
  return {
    addMessageAction: candidate.addMessageAction.bind(candidate),
    addMessagePrefix: candidate.addMessagePrefix.bind(candidate),
    addComposerContext: candidate.addComposerContext.bind(candidate),
    setComposerContext: candidate.setComposerContext.bind(candidate),
  };
}
