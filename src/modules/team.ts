import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasErrorCode } from "../core/errors.ts";

export type TeamMessageType =
  | "message"
  | "broadcast"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval_response";

export interface TeamMessage {
  type: TeamMessageType;
  from: string;
  content: string;
  timestamp: string;
  requestId?: string;
  approved?: boolean;
}

export interface TeamMember {
  name: string;
  role: string;
  status: "idle" | "working" | "shutdown";
}

export class MessageBus {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async send(input: {
    from: string;
    to: string;
    content: string;
    type?: TeamMessageType;
    extra?: Partial<TeamMessage>;
  }): Promise<string> {
    await this.init();
    const message: TeamMessage = {
      type: input.type ?? "message",
      from: input.from,
      content: input.content,
      timestamp: new Date().toISOString(),
      ...input.extra,
    };
    await appendFile(this.inboxPath(input.to), `${JSON.stringify(message)}\n`, "utf8");
    return `Sent ${message.type} from ${input.from} to ${input.to}`;
  }

  async readInbox(name: string): Promise<TeamMessage[]> {
    await this.init();
    const path = this.inboxPath(name);
    try {
      const raw = await readFile(path, "utf8");
      await writeFile(path, "", "utf8");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TeamMessage);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async broadcast(from: string, content: string, members: string[]): Promise<string> {
    let count = 0;
    for (const member of members) {
      if (member === from) continue;
      await this.send({ from, to: member, content, type: "broadcast" });
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }

  private inboxPath(name: string): string {
    return join(this.dir, `${name}.jsonl`);
  }
}

export class TeamRoster {
  private readonly configPath: string;

  constructor(teamDir: string) {
    this.configPath = join(teamDir, "config.json");
  }

  async list(): Promise<TeamMember[]> {
    try {
      const config = JSON.parse(await readFile(this.configPath, "utf8")) as { members: TeamMember[] };
      return config.members;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async upsert(member: TeamMember): Promise<TeamMember[]> {
    const members = await this.list();
    const index = members.findIndex((item) => item.name === member.name);
    if (index >= 0) members[index] = member;
    else members.push(member);
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify({ teamName: "default", members }, null, 2), "utf8");
    return members;
  }

  async render(): Promise<string> {
    const members = await this.list();
    if (members.length === 0) return "No teammates.";
    return members.map((member) => `${member.name} (${member.role}) - ${member.status}`).join("\n");
  }
}

export function createTeamTools(input: {
  bus: MessageBus;
  roster: TeamRoster;
  self: string;
}) {
  return {
    send_message: async (args: Record<string, unknown>) => {
      return input.bus.send({
        from: input.self,
        to: String(args.to ?? ""),
        content: String(args.content ?? ""),
        type: args.type as TeamMessageType | undefined,
      });
    },
    read_inbox: async () => {
      return JSON.stringify(await input.bus.readInbox(input.self), null, 2);
    },
    broadcast: async (args: Record<string, unknown>) => {
      const members = (await input.roster.list()).map((member) => member.name);
      return input.bus.broadcast(input.self, String(args.content ?? ""), members);
    },
    list_team: async () => input.roster.render(),
  };
}
