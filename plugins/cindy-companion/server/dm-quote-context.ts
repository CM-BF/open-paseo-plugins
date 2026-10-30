import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type { JsonValue } from '@getpaseo/protocol/agent-types';
import { DM_QUOTE_CONTEXT_ID, dmQuoteDisplaySchema } from '../shared/dm-quotes';
import { throwIpcError } from './errors';
import type { Paseo } from './runtime';
import type { CompanionService } from './service';

/** Structural bridge for the unreleased public resolver API; npm 0.13.2 has no such export.
 * The host owns input identity, registration lifetime and final sending authorization.
 * This callback only prepares an owned canonical conversation's quote.
 */
export interface DmQuoteInputContextResolver {
  id: string;
  resolve(request: { readonly agent: Readonly<PluginHookAgent>; readonly clientMessageId: string; readonly value: JsonValue },
    context: { paseo: Paseo; signal: AbortSignal }): Promise<{ modelContext: string; displayData: JsonValue }>;
}
interface InputContextHost {
  addInputContextResolver(resolver: DmQuoteInputContextResolver): () => void;
}
function supportsResolver(server: object): server is InputContextHost {
  return 'addInputContextResolver' in server && typeof server.addInputContextResolver === 'function';
}

export function registerDmQuoteContext(server: object, service: Pick<CompanionService, 'prepareDmQuote'>): () => void {
  if (!supportsResolver(server)) return () => {};
  const lifetime = new AbortController();
  const remove = server.addInputContextResolver({
    id: DM_QUOTE_CONTEXT_ID,
    async resolve(request, context) {
      // Capture once: replacing a caller's mutable context cannot replace this cancellation scope.
      const sources = [context.signal, lifetime.signal];
      const controller = new AbortController(), signal = controller.signal;
      const abort = () => controller.abort();
      const check = () => {
        if (signal.aborted) throwIpcError('DM_SOURCE_CLOSED', 'The quote preparation was cancelled');
      };
      for (const source of sources) source.addEventListener('abort', abort, { once: true });
      try {
        if (sources.some(source => source.aborted)) abort();
        check();
        const result = await service.prepareDmQuote(context.paseo, request.agent.id, request.value, signal);
        check();
        return { modelContext: result.modelContext, displayData: dmQuoteDisplaySchema.parse(result.displayData) };
      } finally {
        for (const source of sources) source.removeEventListener('abort', abort);
      }
    },
  });
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    remove();
  };
}
