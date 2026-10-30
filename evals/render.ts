/** 把任务里的占位符替换成每次 trial 的实际路径。 */

export interface RenderVars {
  WORKSPACE: string;
  OUTSIDE: string;
}

export function renderTemplate(template: string, vars: RenderVars): string {
  return template
    .replaceAll("{{WORKSPACE}}", vars.WORKSPACE)
    .replaceAll("{{OUTSIDE}}", vars.OUTSIDE);
}

/** 递归替换脚本步骤里的字符串参数。 */
export function renderValue(value: unknown, vars: RenderVars): unknown {
  if (typeof value === "string") return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, vars)]),
    );
  }
  return value;
}
