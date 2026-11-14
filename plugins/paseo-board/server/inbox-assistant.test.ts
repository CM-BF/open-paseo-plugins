import { describe, expect, it } from "vitest";
import { PHASE0_REFUSAL, RESUME_REFUSAL, assistantSystemPrompt } from "./inbox-assistant";

describe("comment assistant texts (lockdown design §3.9, §4)", () => {
  it("states the exact Phase 0 refusal and resume texts", () => {
    expect(PHASE0_REFUSAL).toBe("暂时不能开启自动处理：当前版本的评论助手会继承这台电脑上其他插件和 Claude Code 用户设置给的工具和权限，无法保证它只用评论工具。等插件更新后再开启。");
    expect(RESUME_REFUSAL).toBe("请先重新开启自动处理：等插件更新后再开启。");
  });
  it("scopes the system prompt to one Board, one visitor's batch and the four inbox tools", () => {
    const prompt = assistantSystemPrompt({ id: "board-a", title: "访客评论 \"演示\"\n第二行" });
    expect(prompt).toContain('the Paseo Board "访客评论 演示第二行" (boardId board-a)');
    expect(prompt).toContain("up to 8 new comments from one visitor");
    expect(prompt).toContain("You have only the four board_inbox_* tools and can reach only the comments listed in this run");
    expect(prompt).not.toMatch(/agent|Paseo agent/i);
  });
});
