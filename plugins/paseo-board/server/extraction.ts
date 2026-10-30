import { createHash } from "node:crypto";
import type { DecisionInput } from "../shared/contracts";
import type { TimelineEntry } from "./sdk";

const CHOICE = /(?:我(?:们)?(?:决定|选择|采用|改为|将只|先只|暂时只|默认)|默认(?:采用|使用|只|不)|(?:I|we)\s+(?:decided|chose|selected|will (?:only|use|skip|limit)|am using|are using)|(?:default(?:ing)? to|scope (?:is|will be) limited))/i;
const IMPACT = /(?:仅|只|不再|兼容|预算|成本|范围|依赖|假设|参数|默认|跳过|替换|过滤|支持|安全|权限|比较|评估|采样|数据|旧版|only|skip|budget|cost|scope|compatib|assum|depend|parameter|sample|filter|baseline|evaluat|security|permission|instead|replace|default)/i;
const ATTRIBUTED_TO_USER = /(?:用户|你的(?:要求|选择|决定)|你(?:要求|决定|选择)|(?:the user|you)\s+(?:asked|requested|chose|decided)|your\s+(?:request|choice|decision))/i;

/** Conservative evidence collector: candidate choices, never invented reasons or user decisions. */
export function extractCandidates(agentId: string, epoch: string, entry: TimelineEntry): DecisionInput[] {
  if (entry.item.type !== "assistant_message") return [];
  const text = entry.item.text.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "");
  const sentences = text.split(/(?<=[。！？.!?])\s*|\n+/u).map((line) => line.trim()).filter(Boolean);
  return sentences.filter((line) => line.length >= 10 && CHOICE.test(line) && IMPACT.test(line) && !ATTRIBUTED_TO_USER.test(line))
    .slice(0, 4).map((line) => {
      const excerpt = line.slice(0, 3500);
      const digest = createHash("sha256").update(`${agentId}\0${excerpt}`).digest("hex").slice(0, 24);
      return {
        id: `inferred-${digest}`, choice: excerpt, basis: "inferred", status: "active",
        evidence: [{ kind: "message", reference: `agent:${agentId}/timeline/${epoch}/${entry.seqStart}-${entry.seqEnd}`, excerpt }],
        related: [], authorAgentId: agentId,
      };
    });
}
