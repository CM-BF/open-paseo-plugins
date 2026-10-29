import type { PluginServerContext } from '@getpaseo/plugin/server';
import { bootstrapRpc, invokeRpc } from './shared/contracts';
import { CompanionService } from './server/service';
import { CompanionMcpServer } from './server/mcp';
import { registerSessionTools } from './server/session-tools';

export default function contribute(server: PluginServerContext) {
  const service = new CompanionService();
  const mcp = new CompanionMcpServer({ root: service.store.root,
    safePath: path => service.store.safePath(path), readProfile: id => service.store.get(id),
    invokeMemory: (id, op, args) => service.invokeMemoryTool(id, op, args),
    validateScope: (id, scope) => service.validateSessionScope(id, scope),
    invokeSession: (id, scope, op, args) => service.invokeSessionTool(id, scope, op, args),
    registerSessionTools });
  service.runtime.setMcpFactory(async (id, scope) => ({ ...await mcp.configFor(id, scope) }));
  void service.restoreToolEndpoint().catch(error => console.error('[cindy-companion] tool endpoint restore failed', error instanceof Error ? error.message : String(error)));
  server.handle(invokeRpc, (input, { paseo }) => service.invoke(input, paseo));
  server.handle(bootstrapRpc, ({ botId }, { paseo }) => service.invoke({ op: 'paseo.bootstrap', args: { botId } }, paseo));
  server.before('agent.create', ({ request }, { paseo }) => service.beforeCreateRoutine(request, paseo));
  server.on('agent.turn_ended', ({ agent }, { paseo }) => {
    void service.applyPendingForAgent(paseo, agent.id).catch(error => console.error('[cindy-companion] pending profile remains unapplied', error instanceof Error ? error.message : String(error)));
    void service.onNativeTaskTurnEnded(paseo, agent.id).catch(error => console.error('[cindy-companion] queued task remains pending', error instanceof Error ? error.message : String(error)));
  });
  return async () => { await Promise.all([service.close(), mcp.close()]); };
}
