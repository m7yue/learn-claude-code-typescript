import test from 'node:test';
import assert from 'node:assert/strict';

import { cronMatches, parseCronField, validateCron } from '../runtime/cron.ts';

test('*/N 从字段最小值起算：日/月从 1 开始', () => {
  // 2024-01-01 是周一；日字段 */2 应匹配 1、3、5...
  assert.equal(cronMatches('0 0 */2 * *', new Date(2024, 0, 1)), true);
  assert.equal(cronMatches('0 0 */2 * *', new Date(2024, 0, 2)), false);
  // 月字段 */2 应匹配 1、3、5...，二月不匹配
  assert.equal(cronMatches('0 0 15 */2 *', new Date(2024, 0, 15)), true);
  assert.equal(cronMatches('0 0 15 */2 *', new Date(2024, 1, 15)), false);

  const dom = parseCronField('*/2', 1, 31);
  assert.ok(dom instanceof Set);
  assert.equal(dom.has(1), true);
  assert.equal(dom.has(2), false);
});

test('日/星期同时受限时用 OR 语义', () => {
  // 2024-01-02 是周二（getDay=2）；DOM=5 不命中，DOW=2 命中
  assert.equal(cronMatches('0 0 5 * 2', new Date(2024, 0, 2)), true);
  assert.equal(cronMatches('0 0 5 * 3', new Date(2024, 0, 2)), false);
});

test('非法表达式在注册时被拒绝', () => {
  assert.match(validateCron('0 99 * * *') ?? '', /hour|Value/);
  assert.match(validateCron('*/0 * * * *') ?? '', /Step/);
  assert.match(validateCron('0 0 * *') ?? '', /5 fields/);
  assert.equal(validateCron('*/5 * * * *'), null);
});
