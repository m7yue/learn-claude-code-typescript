import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { settleActiveWithin } from '../runtime/wait.ts';
import { resolveWithin } from '../runtime/paths.ts';
import { truncate } from '../runtime/text.ts';

test('settleActiveWithin：空表立即返回空数组', async () => {
  assert.deepEqual(await settleActiveWithin(new Map(), 100), []);
});

test('settleActiveWithin：全部结束返回空数组', async () => {
  const active = new Map<string, Promise<string>>([
    ['a', Promise.resolve('a')],
    ['b', Promise.resolve('b')],
  ]);
  assert.deepEqual(await settleActiveWithin(active, 1000), []);
});

test('settleActiveWithin：超时返回仍在运行的 key', async () => {
  const pending = new Promise<string>(() => {});
  const active = new Map<string, Promise<string>>([
    ['done', Promise.resolve('done')],
    ['slow', pending],
  ]);
  assert.deepEqual(await settleActiveWithin(active, 20), ['done', 'slow']);
});

test('resolveWithin：普通子路径与 ..foo 都允许', () => {
  const base = join(tmpdir(), 'lcc-workspace');
  assert.equal(resolveWithin(base, 'a/b.txt'), join(base, 'a/b.txt'));
  assert.equal(resolveWithin(base, '..foo'), join(base, '..foo'));
  assert.equal(resolveWithin(base, '.'), base);
});

test('resolveWithin：越界路径被拒绝', () => {
  const base = join(tmpdir(), 'lcc-workspace');
  for (const p of ['..', '../outside', '../../etc/passwd', '/etc/passwd', '../lcc-workspace-evil/file']) {
    assert.throws(() => resolveWithin(base, p), `应拒绝 ${p}`);
  }
});

test('truncate：短文本原样，长文本截断并加省略号', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('0123456789abc', 10), '0123456789…');
  assert.equal(truncate('0123456789', 10), '0123456789');
});
