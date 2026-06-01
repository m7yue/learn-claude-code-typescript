import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasErrorCode } from "../core/errors.ts";

export interface MemoryEntry {
  id: string;
  title: string;
  tags: string[];
  content: string;
  updatedAt: string;
}

export class MemoryStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(title: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    await mkdir(this.dir, { recursive: true });
    const id = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-|-$/g, "") || crypto.randomUUID();
    const entry: MemoryEntry = { id, title, tags, content, updatedAt: new Date().toISOString() };
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(entry, null, 2), "utf8");
    return entry;
  }

  async list(): Promise<MemoryEntry[]> {
    try {
      const files = (await readdir(this.dir)).filter((file) => file.endsWith(".json"));
      const entries = await Promise.all(files.map((file) => readFile(join(this.dir, file), "utf8").then(JSON.parse)));
      return entries.sort((a, b) => a.title.localeCompare(b.title));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return (await this.list()).filter((entry) => {
      return [entry.title, entry.content, entry.tags.join(" ")].join("\n").toLowerCase().includes(q);
    });
  }
}
