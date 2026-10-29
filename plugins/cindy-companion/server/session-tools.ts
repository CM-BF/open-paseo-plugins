import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CompanionSessionTools } from './mcp';
import { registerCompanionSkillTools } from './companion-skills-tools';
/** Input names/limits follow pinned Cindy lizi_xdtHelperMcpServer.ts:381-721. Host-only caller identity is omitted. */
export function registerSessionTools(server:McpServer,context:CompanionSessionTools):void{
  registerCompanionSkillTools(server, context);
  server.registerTool('list_agents',{description:'List active local companions by stable id. Remote device discovery is not connected on this host.',inputSchema:{}},()=>context.invoke('list_agents',{}));
  server.registerTool('start_session_task',{
    description:'Start an independent tracked native session for work that needs separate execution. Pass all required context; it does not inherit this chat or companion memory. The group receives a task card and frozen result. Private task results remain available in the task card; do not claim automatic parent delivery. Start once; an unknown outcome must not be replayed. This does not contact a named teammate.',
    inputSchema:{instruction:z.string().min(1).max(12000),title:z.string().min(1).max(120).optional(),working_dir:z.string().min(1).max(1024).optional(),use_worktree:z.boolean().optional(),context_refs:z.array(z.string().max(512)).max(32).optional(),timeout_ms:z.number().int().min(1000).max(86400000).optional(),idempotency_key:z.string().min(1).max(128).optional()},
  },args=>context.invoke('start_session_task',args));
  server.registerTool('check_session_task',{description:'Read one task created by this exact session, its pending queue and frozen per-run results. Read when needed, without polling.',inputSchema:{task_id:z.string().min(1).max(128)}},args=>context.invoke('check_session_task',args));
  server.registerTool('message_session_task',{description:'Add new input to the same task. Busy input waits for its next turn; resume releases a pause without replaying the original objective. Edit/withdraw affect only unconsumed input. Native permissions must be answered in the task session. Reuse idempotency_key for the same action.',inputSchema:{task_id:z.string().min(1).max(128),message:z.string().min(1).max(4000).optional(),mode:z.enum(['queue','resume','edit','withdraw']).optional(),queued_message_id:z.string().min(1).max(256).optional(),idempotency_key:z.string().min(1).max(128).optional()}},args=>context.invoke('message_session_task',args));
  server.registerTool('stop_session_task',{description:'Stop an owned task. pause preserves queued inputs until resume; request-stop stops the current execution; cancel terminates it. Acceptance is not stop confirmation; unknown status requires reconciliation, never resend.',inputSchema:{task_id:z.string().min(1).max(128),mode:z.enum(['cancel','request-stop','pause']).optional()}},args=>context.invoke('stop_session_task',args));
}
