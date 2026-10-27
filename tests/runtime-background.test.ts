import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundRegistry } from '../runtime/background.ts';
import type { ToolUseBlock } from '../runtime/types.ts';

function block(command = 'echo hi'): ToolUseBlock {
  return { type: 'tool_use', id: 'call_1', name: 'bash', input: { command } };
}

test('后台任务：完成通知带 task-id/status/output-file，collect 后删除记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcc-background-'));
  try {
    const registry = new BackgroundRegistry({
      executor: async () => 'hello from background',
      outputDir: dir,
    });
    const bgId = registry.start(block());
    assert.equal(bgId, 'bg_0001');

    const notes = await registry.collect(true);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /<task-id>bg_0001<\/task-id>/);
    assert.match(notes[0], /<task-type>local_bash<\/task-type>/);
    assert.match(notes[0], /<status>completed<\/status>/);
    assert.match(notes[0], /<output-file>/);
    assert.ok(existsSync(join(dir, 'bg_0001.log')));

    assert.deepEqual(await registry.collect(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('后台任务失败标为 failed，并保留错误输出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcc-background-fail-'));
  try {
    const registry = new BackgroundRegistry({
      executor: async () => {
        throw new Error('boom');
      },
      outputDir: dir,
    });
    registry.start(block());
    const notes = await registry.collect(true);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /<status>failed<\/status>/);
    assert.match(notes[0], /Error: boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForAll 超时后不会永远等下去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcc-background-wait-'));
  try {
    const registry = new BackgroundRegistry({
      executor: () => new Promise<string>(() => {}),
      outputDir: dir,
      waitTimeoutMs: 20,
    });
    registry.start(block());
    const started = Date.now();
    await registry.waitForAll();
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(await registry.collect(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
