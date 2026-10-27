import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCompactor,
  microCompact,
  planPersists,
  applyPersist,
  snipCompact,
} from '../runtime/compaction.ts';
import type { LLMResponse, Message, ToolResultBlock } from '../runtime/types.ts';

const fakeChat = async (): Promise<LLMResponse> => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'SUMMARY' }],
});

const fakeMock = (): LLMResponse => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'SUMMARY' }],
});

function baseMessages(count: number): Message[] {
  const messages: Message[] = [{ role: 'user', content: '原始任务：重构认证模块' }];
  for (let i = 1; i < count; i += 1) {
    messages.push({
      role: i % 2 === 1 ? 'assistant' : 'user',
      content: `消息 ${i}`,
    });
  }
  return messages;
}

test('snipCompact 保留最初任务和头部，不把消息全裁掉', () => {
  const messages = baseMessages(60);
  const snipped = snipCompact(messages);
  assert.ok(snipped.length < messages.length);
  assert.equal(snipped[0].content, '原始任务：重构认证模块');
  assert.ok(snipped.some((m) => typeof m.content === 'string' && m.content.startsWith('[snipped')));
});

test('microCompact 只清较早且足够长的工具结果，保留最近 N 个', () => {
  const messages: Message[] = [];
  for (let i = 0; i < 5; i += 1) {
    const block: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: `t${i}`,
      // 最早两个是长结果（应被清理），最近三个保持原样
      content: i < 2 ? `long-${i}-` + 'x'.repeat(200) : `keep-${i}-` + 'y'.repeat(200),
    };
    messages.push({ role: 'user', content: [block] });
  }
  microCompact(messages, 3);
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.equal(
    results[0].type === 'tool_result' && results[0].content,
    '[Earlier tool result compacted. Re-run if needed.]',
  );
  assert.equal(
    results[1].type === 'tool_result' && results[1].content,
    '[Earlier tool result compacted. Re-run if needed.]',
  );
  assert.match(String(results[2].type === 'tool_result' && results[2].content), /^keep-2-/);
  assert.match(String(results[4].type === 'tool_result' && results[4].content), /^keep-4-/);
});

test('planPersists 按总量挑出大块，applyPersist 替换为引用', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'a'.repeat(150_000) },
        { type: 'tool_result', tool_use_id: 'b', content: 'b'.repeat(100_000) },
      ],
    },
  ];
  const plan = planPersists(messages);
  assert.ok(plan.length > 0);
  for (const item of plan) applyPersist(messages, item.toolUseId, '<persisted-output>');
  const blocks = messages[0].content as ToolResultBlock[];
  assert.ok(blocks.some((b) => b.content === '<persisted-output>'));
});

test('compactHistory 与 reactiveCompact 保留摘要、原任务和尾部', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcc-compaction-'));
  try {
    const compactor = createCompactor({
      chat: fakeChat,
      mockSummarizer: fakeMock,
      transcriptsDir: dir,
    });
    const messages = baseMessages(7);
    const compacted = await compactor.compactHistory(messages);
    assert.ok(
      compacted.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[Compacted]') && m.content.includes('SUMMARY'),
      ),
    );
    assert.ok(compacted.some((m) => m.content === '原始任务：重构认证模块'));

    const reactive = await compactor.reactiveCompact(baseMessages(12));
    assert.ok(
      reactive.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[Reactive compact]'),
      ),
    );
    assert.ok(reactive.some((m) => m.content === '原始任务：重构认证模块'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
