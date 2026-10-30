import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CompanionSessionTools } from './mcp';

/** Adapted from pinned Cindy packages/lizi-mcps/src/xdt-helper/bot_skills.ts. */
export function registerCompanionSkillTools(server: McpServer, context: CompanionSessionTools): void {
  const list = {
    description: '列出当前伙伴已经学会的技能（名称 / 说明 / 更新时间，不含正文）。按 query 搜索完整名称和说明；大目录分页返回，使用 nextOffset 和返回的 revision 作为 expected_revision 继续，目录变化时从第一页重读，不能把第一页当成全部。enabled=false 的技能保留但未启用。准备修改时使用 read_teammate_skill 获取全文和文档 revision（不同于目录 revision）。保存和原生加载是分开的状态，不能据列表声称当前模型已经加载。',
    inputSchema: { query: z.string().max(1024).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional(), expected_revision: z.string().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  };
  const save = {
    description: '用户明确要求把一套做法记成技能、或纠正已有技能时，存成 / 更新当前伙伴自己的一个真技能文件。其他时候不在对话里新建技能。body 写可照做的步骤，不写这一次的结论。同 slug 更新前先 read_teammate_skill，传它返回的 exact revision；新建传 expected_revision=null。一次操作固定一个 idempotency_key，丢回执只重试同一参数和 key。群聊/计划执行会话只能读，不能改伙伴技能。以返回的 runtime 为准；保存成功不代表当前轮已原生加载。',
    inputSchema: {
      name: z.string().min(1).max(64), description: z.string().min(1).max(280), body: z.string().min(1).max(65536),
      slug: z.string().min(1).max(64).optional(), expected_revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
      idempotency_key: z.string().min(1).max(200),
    },
  };
  for (const name of ['list_teammate_skills', 'list_bot_skills'])
    server.registerTool(name, list, args => context.invoke('list_teammate_skills', args));
  for (const name of ['save_teammate_skill', 'save_bot_skill'])
    server.registerTool(name, save, args => context.invoke('save_teammate_skill', args));
  server.registerTool('read_teammate_skill', {
    description: '读当前伙伴的一份技能及 exact revision，用于执行前检查或保护用户并发编辑。disabled 的技能可查看但不能作为已启用技能执行。',
    inputSchema: { slug: z.string().min(1).max(64) }, annotations: { readOnlyHint: true },
  }, args => context.invoke('read_teammate_skill', args));
  server.registerTool('inspect_teammate_skill', {
    description: '读取技能的有界元数据和 exact revision。大文件无法在内嵌编辑器打开时，仍可检查其字节大小和启用状态；分块校验版本，不返回全文。',
    inputSchema: { slug: z.string().min(1).max(64) }, annotations: { readOnlyHint: true },
  }, args => context.invoke('inspect_teammate_skill', args));
}
