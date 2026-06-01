import type { TeamMessage } from "./team.ts";

export interface ProtocolRequest {
  requestId: string;
  from: string;
  to: string;
  kind: "plan_approval" | "shutdown";
  content: string;
  status: "pending" | "approved" | "rejected";
}

export class ProtocolState {
  private readonly requests = new Map<string, ProtocolRequest>();

  create(input: Omit<ProtocolRequest, "requestId" | "status">): ProtocolRequest {
    const request: ProtocolRequest = { requestId: crypto.randomUUID(), status: "pending", ...input };
    this.requests.set(request.requestId, request);
    return request;
  }

  applyResponse(message: TeamMessage): ProtocolRequest | undefined {
    if (!message.requestId) return undefined;
    const request = this.requests.get(message.requestId);
    if (!request) return undefined;
    if (message.approved === true) request.status = "approved";
    if (message.approved === false) request.status = "rejected";
    return request;
  }

  list(): ProtocolRequest[] {
    return [...this.requests.values()];
  }
}
