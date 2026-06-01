import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasErrorCode } from "../core/errors.ts";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

export class SkillRegistry {
  private readonly dir: string;
  private skills = new Map<string, Skill>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();
    for (const file of await this.findSkillFiles(this.dir)) {
      const raw = await readFile(file, "utf8");
      const skill = parseSkill(file, raw);
      this.skills.set(skill.name, skill);
    }
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`未知 skill: ${name}`);
    return skill;
  }

  private async findSkillFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return this.findSkillFiles(path);
        return entry.name === "SKILL.md" ? [path] : [];
      }));
      return nested.flat();
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }
}

function parseSkill(path: string, raw: string): Skill {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const metaRaw = match?.[1] ?? "";
  const body = (match?.[2] ?? raw).trim();
  const meta = Object.fromEntries(
    metaRaw.split("\n")
      .map((line) => line.split(":"))
      .filter((parts) => parts.length >= 2)
      .map(([key, ...value]) => [key.trim(), value.join(":").trim()]),
  );
  const parts = path.split("/");
  const fallback = parts[parts.length - 2] ?? "unknown";
  return {
    name: meta.name ?? fallback,
    description: meta.description ?? "",
    body,
    path,
  };
}
