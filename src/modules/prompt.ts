import { ENVIRONMENT_PROMPT, WORKDIR } from "../../runtime/system-prompt.ts";

export interface PromptSection {
  id: string;
  content: string;
  enabledWhen?: (context: PromptContext) => boolean;
}

export interface PromptContext {
  cwd: string;
  hasOpenTodos?: boolean;
  hasTeam?: boolean;
  loadedSkills?: string[];
  mode?: "default" | "plan" | "review";
}

export class SystemPromptAssembler {
  private readonly sections: PromptSection[] = [];
  private cacheKey = "";
  private cacheValue = "";

  add(section: PromptSection): void {
    this.sections.push(section);
    this.cacheKey = "";
  }

  assemble(context: PromptContext): string {
    const key = JSON.stringify(context);
    if (key === this.cacheKey) return this.cacheValue;
    const prompt = this.sections
      .filter((section) => section.enabledWhen?.(context) ?? true)
      .map((section) => `<${section.id}>\n${section.content}\n</${section.id}>`)
      .join("\n\n");
    this.cacheKey = key;
    this.cacheValue = prompt;
    return prompt;
  }
}

export function createDefaultPromptAssembler(): SystemPromptAssembler {
  const assembler = new SystemPromptAssembler();
  assembler.add({ id: "identity", content: "你是一个编码助手。模型负责决策，harness 负责执行。直接行动，不要多解释。" });
  assembler.add({ id: "environment", content: `运行环境：${ENVIRONMENT_PROMPT}。` });
  assembler.add({ id: "workspace", content: `工作目录：${WORKDIR}；所有文件操作默认限制在工作区内。` });
  assembler.add({
    id: "todo-nudge",
    content: "如果任务超过两步，先使用 todo_write 明确计划。",
    enabledWhen: (context) => context.hasOpenTodos !== false,
  });
  assembler.add({
    id: "team",
    content: "如果有队友，使用结构化消息沟通，不要依赖口头约定。",
    enabledWhen: (context) => Boolean(context.hasTeam),
  });
  return assembler;
}
