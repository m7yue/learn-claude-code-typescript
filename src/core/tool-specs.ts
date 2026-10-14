/**
 * 从 runtime 的工具注册表派生出工程层的 ToolDefinition。
 *
 * 这是「单一真源」的工程侧入口：name / description / parameters 全部来自
 * runtime/tool-schemas.ts，杜绝工程层与章节层各自维护一份描述而漂移。
 */

import { specFor } from "../../runtime/tool-schemas.ts";
import type { ToolDefinition } from "./types.ts";

/** 按名称把注册表条目转成 ToolDefinition；未注册的名字由 specFor 直接抛错。 */
export function specsToToolDefinitions(...names: string[]): ToolDefinition[] {
  return names.map((name) => {
    const spec = specFor(name);
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.input_schema,
    };
  });
}
