/**
 * s20 的 mock 剧本 —— 只替换“模型调用”这一步。
 * 脚本状态放在 memo 里，由 handler 回填真实 id，mock 据此引用真实任务/请求。
 */

import type { LLMResponse, Message } from '../runtime/types.ts';
import { textBlock, toolUse } from './blocks.ts';
import {
  LEAD_ID,
  OUTPUT_DIR,
  SUBAGENT_ID,
  WORKER_ID,
  WORKER_ROLE,
  WORKTREE_NAME,
} from './config.ts';

/** 全局确定性脚本状态：mock 只换「模型调用」，这些是它跨轮次记住的东西。 */
export const memo = {
  leadRound: 0,
  teammateRound: 0,
  subagentRound: 0,
  planRequestId: '',
  // subject → 持久化任务 id：由 CreateTask handler 真实回填，
  // 让 mock 能引用真实 id（而非依赖扫描聊天文本），并真实演示 blockedBy DAG。
  taskIdBySubject: {} as Record<string, string>,
};

/** mock 计划注入的错误：leadRound → 该轮首次调用前抛出，重试后不再抛。 */
const leadErrorArms: Array<{ kind: '429' | '529'; count: number } | undefined> = [];
leadErrorArms[6] = { kind: '429', count: 1 }; // 429 → 退避重试
leadErrorArms[9] = { kind: '529', count: 2 }; // 连续 529 → 切换备用模型

function mockLead(messages: Message[]): LLMResponse {
  void messages; // 脚本状态由 memo 驱动
  const round = memo.leadRound;
  const arm = leadErrorArms[round];
  if (arm && arm.count > 0) {
    arm.count -= 1;
    throw Object.assign(
      new Error(arm.kind === '429' ? '429 rate limit exceeded' : '529 overloaded_error: service overloaded'),
      { status: Number(arm.kind) },
    );
  }
  // 用真实回填的 subject→id 映射引用任务（CreateTask handler 写入 memo）。
  const a = memo.taskIdBySubject['设计接口'] ?? '';
  const b = memo.taskIdBySubject['实现核心'] ?? '';
  const c = memo.taskIdBySubject['集成测试'] ?? '';
  const reqId = memo.planRequestId;

  const respond = (resp: LLMResponse): LLMResponse => {
    memo.leadRound += 1;
    return resp;
  };

  switch (round) {
    case 0:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('阶段1 初始化：读取历史记忆、加载技能、登记待办。'),
          toolUse('L0a', 'read_memory', { query: '项目历史' }),
          toolUse('L0b', 'load_skill', { name: 'worktree-isolation' }),
          toolUse('L0c', 'todo_write', {
            todos: [
              { content: '初始化运行时', status: 'completed', activeForm: '初始化运行时' },
              { content: '规划认证重构任务图', status: 'in_progress', activeForm: '规划任务图' },
              { content: '隔离执行与验证', status: 'pending', activeForm: '隔离执行与验证' },
            ],
          }),
        ],
      });
    case 1:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('阶段2 规划：拉起队友并请求一份执行计划（先派队友，避免其空转）。'),
          toolUse('L1a', 'spawn_teammate', { agentId: WORKER_ID, role: WORKER_ROLE }),
          toolUse('L1b', 'request_plan', { goal: '重构认证模块', context: '升级到 OAuth 2.0，保持向后兼容' }),
        ],
      });
    case 2:
      // 先创建无依赖的 D / A / B（D 放在前面，便于 worker 空闲时自主认领；
      // C 依赖 A、B，下一轮才能引用真实 id）。
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建任务图的根节点：迁移说明、接口设计、核心实现。'),
          toolUse('L2d', 'create_task', {
            subject: '编写迁移说明',
            description: '面向升级用户的说明文档',
            blockedBy: [],
            preferredOwner: WORKER_ID,
          }),
          toolUse('L2a', 'create_task', {
            subject: '设计接口',
            description: '定义 OAuth2 适配器接口',
            blockedBy: [],
            preferredOwner: LEAD_ID,
          }),
          toolUse('L2b', 'create_task', {
            subject: '实现核心',
            description: '实现 token 刷新',
            blockedBy: [],
            preferredOwner: LEAD_ID,
          }),
        ],
      });
    case 3:
      // C 依赖 A、B：用已回填的真实 id；并收取队友计划审批请求。
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建依赖 A、B 的集成测试任务，并等待队友的计划审批请求。'),
          toolUse('L3a', 'create_task', {
            subject: '集成测试',
            description: '端到端验证',
            blockedBy: [a, b],
            preferredOwner: LEAD_ID,
          }),
          toolUse('L3b', 'check_inbox', { expectType: 'plan_approval_request' }),
        ],
      });
    case 4:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('调用 MCP 工具，检查被依赖阻塞的任务（claim 应失败），并审批队友计划。'),
          toolUse('L4a', 'mcp__docs__search', { query: 'oauth2' }),
          toolUse('L4b', 'get_task', { taskId: c }),
          toolUse('L4c', 'claim_task', { taskId: c }),
          toolUse('L4d', 'review_plan', { requestId: reqId, reviewerId: LEAD_ID }),
        ],
      });
    case 5:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('认领可开始的任务，并启动后台构建监控。'),
          toolUse('L5a', 'claim_task', { taskId: a }),
          toolUse('L5b', 'claim_task', { taskId: b }),
          toolUse('L5c', 'bash', { command: 'echo "start build monitor"', run_in_background: true }),
        ],
      });
    case 6:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('完成任务并产出文档（本轮会触发一次 429，由退避重试恢复）。'),
          toolUse('L6a', 'complete_task', { taskId: a }),
          toolUse('L6b', 'complete_task', { taskId: b }),
          toolUse('L6c', 'write_file', { path: `${OUTPUT_DIR}/report.md`, content: '# 认证重构报告\n\n1. 适配器接口\n2. token 刷新\n' }),
          toolUse('L6d', 'glob', { pattern: `${OUTPUT_DIR}/*.md` }),
        ],
      });
    case 7:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('修订文档、读取文档，并派发子代理编写单元测试。'),
          toolUse('L7a', 'edit_file', { path: `${OUTPUT_DIR}/report.md`, old_text: '2. token 刷新', new_text: '2. token 刷新（含 PKCE）' }),
          toolUse('L7b', 'read_file', { path: `${OUTPUT_DIR}/report.md` }),
          toolUse('L7c', 'task', { task: '为认证适配器编写单元测试' }),
        ],
      });
    case 8:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('运行一个大输出命令，触发大结果落盘（PersistOutput）。'),
          toolUse('L8a', 'bash', { command: 'node -e "process.stdout.write(\'L\'.repeat(250000))"' }),
        ],
      });
    case 9:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建隔离 worktree（本轮连续 529，由模型切换恢复）。'),
          toolUse('L9a', 'create_worktree', { worktreeId: WORKTREE_NAME, taskId: c }),
        ],
      });
    case 10:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('在 worktree 中执行写入，制造未提交变更。'),
          toolUse('L10a', 'bash', { command: 'echo "isolated change" > wt-note.txt', worktreeId: WORKTREE_NAME }),
        ],
      });
    case 11:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('尝试删除有变更的 worktree（应被拒绝），改为保留。'),
          toolUse('L11a', 'remove_worktree', { worktreeId: WORKTREE_NAME }),
          toolUse('L11b', 'keep_worktree', { worktreeId: WORKTREE_NAME }),
        ],
      });
    case 12:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('依赖已解除，认领并完成集成测试任务。'),
          toolUse('L12a', 'claim_task', { taskId: c }),
          toolUse('L12b', 'complete_task', { taskId: c }),
          toolUse('L12c', 'list_tasks', {}),
        ],
      });
    case 13:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('调度 cron：一个本分钟触发的巡检 + 一个每日持久任务，并取消后者。'),
          toolUse('L13a', 'schedule_cron', { cronId: 'health', cron: '* * * * *', prompt: '执行健康巡检', recurring: true, durable: false }),
          toolUse('L13b', 'schedule_cron', { cronId: 'nightly-cleanup', cron: '0 3 * * *', prompt: '清理临时文件', recurring: true, durable: true }),
          toolUse('L13c', 'cancel_cron', { cronId: 'nightly-cleanup' }),
        ],
      });
    case 14:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('列出 cron 并压缩上下文。'), toolUse('L14a', 'list_crons', {}), toolUse('L14b', 'compact', { reason: '认证重构进度' })],
      });
    case 15:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('丢弃变更并移除 worktree，然后查看任务总表。'),
          toolUse('L15a', 'remove_worktree', { worktreeId: WORKTREE_NAME, discard_changes: true }),
          toolUse('L15b', 'list_tasks', {}),
        ],
      });
    case 16:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('任务完成，请求队友关闭（等待 shutdown_response）。'), toolUse('L16a', 'request_shutdown', { agentId: WORKER_ID, reason: '认证重构已完成' })],
      });
    case 17:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('检查信箱收尾。'), toolUse('L17a', 'check_inbox', {})],
      });
    default:
      return respond({
        stop_reason: 'end_turn',
        content: [textBlock('认证重构完成：任务图、队友协议、后台、cron、worktree、MCP 全部协同收尾。')],
      });
  }
}

function mockTeammate(): LLMResponse {
  const round = memo.teammateRound;
  switch (round) {
    case 0: {
      const plan = '执行计划：\n1. 分析现有认证逻辑\n2. 设计 OAuth 2.0 适配器接口\n3. 实现 token 刷新\n4. 补充向后兼容层';
      memo.teammateRound += 1;
      return { stop_reason: 'tool_use', content: [textBlock(plan), toolUse('T0a', 'submit_plan', { plan })] };
    }
    case 1:
      memo.teammateRound += 1;
      return { stop_reason: 'tool_use', content: [textBlock('计划已批准，查看任务总表。'), toolUse('T1a', 'list_tasks', {})] };
    case 2: {
      // 结束当前回合，进入空闲；IdlePoll 会自主认领“编写迁移说明”（D 是最先创建的任务）。
      memo.teammateRound += 1;
      return { stop_reason: 'end_turn', content: [textBlock('当前没有手头任务，进入空闲等待可认领的工作。')] };
    }
    case 3: {
      const d = memo.taskIdBySubject['编写迁移说明'] ?? '';
      memo.teammateRound += 1;
      return {
        stop_reason: 'tool_use',
        content: [
          textBlock(`已自主认领任务 ${d}，开始编写迁移说明。`),
          toolUse('T3a', 'write_file', { path: `${OUTPUT_DIR}/worker-note.md`, content: '# 迁移说明\n\n1. 更新依赖\n2. 切换 OAuth2\n' }),
          toolUse('T3b', 'complete_task', { taskId: d }),
        ],
      };
    }
    default:
      memo.teammateRound += 1;
      return { stop_reason: 'end_turn', content: [textBlock('worker：迁移说明已编写完成。')] };
  }
}

function mockSubagent(): LLMResponse {
  const round = memo.subagentRound;
  if (round === 0) {
    memo.subagentRound += 1;
    return {
      stop_reason: 'tool_use',
      content: [textBlock('子代理：检查测试目录。'), toolUse('S0a', 'bash', { command: 'echo "subagent scanning tests/"' })],
    };
  }
  memo.subagentRound += 1;
  return { stop_reason: 'end_turn', content: [textBlock('子代理：单元测试骨架已生成（3 个用例）。')] };
}

export function mockModel(agentId: string, messages: Message[]): LLMResponse {
  if (agentId === LEAD_ID) return mockLead(messages);
  if (agentId === SUBAGENT_ID) return mockSubagent();
  void messages;
  return mockTeammate();
}
