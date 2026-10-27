import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatHandlerOptions } from "../runtime/model.ts";
import type { LLMResponse, Message } from "../runtime/types.ts";
import { COMPACTED_MARKER } from "../s20_comprehensive/config.ts";
import {
  SUMMARIZE_INSTRUCTION,
  SUMMARY_MAX_TOKENS,
  compactHistory,
} from "../s20_comprehensive/context.ts";

test("compactHistory 在 real 路径带摘要指令，并保留最初任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcc-s20-context-"));
  try {
    const messages: Message[] = [
      { role: "user", content: "原始任务：重构认证模块" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "继续" },
      { role: "assistant", content: "处理中" },
      { role: "user", content: "再继续" },
      { role: "assistant", content: "处理中" },
      { role: "user", content: "最后一步" },
    ];

    let captured: ChatHandlerOptions | undefined;
    const fakeChat = async (
      _mockFn: (messages: Message[]) => LLMResponse | Promise<LLMResponse>,
      _messages: Message[],
      options?: ChatHandlerOptions,
    ): Promise<LLMResponse> => {
      captured = options;
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "SUMMARY" }],
      };
    };

    const compacted = await compactHistory(messages, {
      chat: fakeChat,
      transcriptsDir: dir,
    });

    assert.equal(captured?.system, SUMMARIZE_INSTRUCTION);
    assert.equal(captured?.maxTokens, SUMMARY_MAX_TOKENS);
    assert.ok(
      compacted.some((m) => m.content === "原始任务：重构认证模块"),
      "压缩后应保留最初任务，避免模型忘记目标",
    );
    assert.ok(compacted.some((m) => m.content === COMPACTED_MARKER));
    assert.ok(
      compacted.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.startsWith("[Compacted]") &&
          m.content.includes("SUMMARY"),
      ),
      "压缩结果应包含摘要正文，而不只是 marker",
    );
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
