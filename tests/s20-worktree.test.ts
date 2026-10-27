import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorktreeManager,
  resolveWorktreePath,
  validateWorktreeName,
} from '../s20_comprehensive/worktree.ts';

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 's20-worktree-'));
  const worktreesDir = join(root, '.worktrees');
  // 故意不预建 .worktrees：create 需要自己建父目录（干净工作区的真实场景）。
  const calls: string[][] = [];
  const events: string[] = [];
  let statusOutput = '';
  let commitOutput = '0';

  const manager = createWorktreeManager({
    worktreesDir,
    runGit: (args) => {
      calls.push(args);
      if (args.includes('status')) return { ok: true, out: statusOutput };
      if (args[0] === 'rev-list') return { ok: true, out: commitOutput };
      // 模拟 git 的真实效果：add 建目录，remove 删目录。
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[2], { recursive: true });
        return { ok: true, out: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const target = args[args.length - 1];
        rmSync(target, { recursive: true, force: true });
        return { ok: true, out: '' };
      }
      return { ok: true, out: '' };
    },
    logEvent: (type, name) => {
      events.push(`${type}:${name}`);
    },
    ensureGitRepo: () => {},
  });

  return {
    root,
    worktreesDir,
    calls,
    events,
    manager,
    setStatus: (value: string) => {
      statusOutput = value;
    },
    setCommits: (value: string) => {
      commitOutput = value;
    },
  };
}

test('worktree 名拒绝空串、.、.. 与路径分隔符', () => {
  for (const name of ['', '.', '..', 'a/b', '../x']) {
    assert.notEqual(validateWorktreeName(name), null, `应拒绝 ${JSON.stringify(name)}`);
  }
  assert.equal(validateWorktreeName('s20-wt'), null);
  assert.equal(validateWorktreeName('..foo'), null);
});

test('resolveWorktreePath 只接受 worktreesDir 的严格子路径', () => {
  const { worktreesDir } = makeHarness();
  assert.equal(resolveWorktreePath(worktreesDir, 'wt1'), join(worktreesDir, 'wt1'));
  // 以 .. 开头的普通文件名是合法的；按分隔符判断才不会误伤。
  assert.equal(resolveWorktreePath(worktreesDir, '..foo'), join(worktreesDir, '..foo'));
  assert.throws(() => resolveWorktreePath(worktreesDir, '..'));
  assert.throws(() => resolveWorktreePath(worktreesDir, '../outside'));
  assert.throws(() => resolveWorktreePath(worktreesDir, '/etc/passwd'));
});

test('create/remove 拒绝 ..，不会删除工作区根目录', () => {
  const { root, manager } = makeHarness();

  const created = manager.create('..');
  assert.equal(created.ok, false);

  const removed = manager.remove('..', true);
  assert.equal(removed.removed, false);
  assert.ok(existsSync(root), '工作区根目录不应被删除');
});

test('keep 后 cleanup 保留目录，显式 remove 仍然生效', () => {
  const { manager } = makeHarness();

  assert.equal(manager.create('wt1').ok, true);
  assert.equal(manager.keep('wt1').kept, true);
  const keptPath = manager.getPath('wt1');
  assert.ok(keptPath && existsSync(keptPath));

  manager.cleanup();
  assert.ok(existsSync(keptPath!), 'keep 的 worktree 应保留');
  assert.deepEqual(manager.paths(), []);

  const removed = manager.remove('wt1', true);
  assert.equal(removed.removed, true);
  assert.equal(existsSync(keptPath!), false);
});

test('create 后显式 remove 会调用 worktree remove 并清空 keep 状态', () => {
  const { manager, calls, events } = makeHarness();

  assert.equal(manager.create('wt1').ok, true);
  assert.equal(manager.keep('wt1').kept, true);
  assert.equal(manager.remove('wt1', true).removed, true);

  assert.ok(
    calls.some((args) => args[0] === 'worktree' && args[1] === 'add'),
    '应调用 git worktree add',
  );
  assert.ok(
    calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'),
    '应调用 git worktree remove',
  );
  assert.ok(events.includes('keep:wt1'));
  assert.ok(events.includes('remove:wt1'));

  // 显式移除后再 keep 应该失败（worktree 已经不存在）。
  assert.equal(manager.keep('wt1').kept, false);
});

test('create 会先建缺失的 .worktrees 父目录', () => {
  const { worktreesDir, manager } = makeHarness();
  assert.equal(existsSync(worktreesDir), false);
  assert.equal(manager.create('wt1').ok, true);
  assert.equal(existsSync(worktreesDir), true);
});

test('已提交未合并的 commit 也会阻止删除，discardChanges=true 才删', () => {
  const { manager, setCommits } = makeHarness();
  assert.equal(manager.create('wt1').ok, true);
  setCommits('2');

  const refused = manager.remove('wt1');
  assert.equal(refused.removed, false);
  assert.match(refused.reason ?? '', /unmerged commit/);

  const forced = manager.remove('wt1', true);
  assert.equal(forced.removed, true);
});

test('有未提交变更时默认拒绝删除，discardChanges=true 才删', () => {
  const { manager, setStatus } = makeHarness();

  assert.equal(manager.create('wt1').ok, true);
  const wtPath = manager.getPath('wt1')!;
  setStatus(' M changed.txt\n');

  const refused = manager.remove('wt1');
  assert.equal(refused.removed, false);
  assert.match(refused.reason ?? '', /uncommitted change/);
  assert.ok(existsSync(wtPath));

  const forced = manager.remove('wt1', true);
  assert.equal(forced.removed, true);
  assert.equal(existsSync(wtPath), false);
});
