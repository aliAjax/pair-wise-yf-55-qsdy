import type { FormField, LinkRule } from './store';

export interface FieldState {
  visible: boolean;
  required: boolean;
}

export interface RuleIssue {
  ruleId: string;
  type: 'cycle' | 'dangling';
  message: string;
}

/**
 * 依赖边：规则 q 读取 q.fieldId，规则 r 作用于 r.targetId；
 * 若 r.targetId === q.fieldId，则 q 依赖 r（r 必须先于 q 计算）。
 */
function buildAdj(rules: LinkRule[]): Map<string, string[]> {
  const adj = new Map<string, string[]>(rules.map((r) => [r.id, []]));
  for (const r of rules) {
    for (const q of rules) {
      if (r.targetId === q.fieldId) adj.get(r.id)!.push(q.id);
    }
  }
  return adj;
}

/** Kahn 拓扑排序；未出现在 order 中的规则即为参与循环依赖的规则。 */
export function topoSortRules(rules: LinkRule[]): { order: LinkRule[]; cycleIds: Set<string> } {
  const adj = buildAdj(rules);
  const indeg = new Map<string, number>(rules.map((r) => [r.id, 0]));
  for (const nexts of adj.values()) {
    for (const n of nexts) indeg.set(n, (indeg.get(n) ?? 0) + 1);
  }
  const queue = rules.filter((r) => indeg.get(r.id) === 0).map((r) => r.id);
  const order: LinkRule[] = [];
  const done = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (done.has(id)) continue;
    done.add(id);
    const r = rules.find((x) => x.id === id)!;
    order.push(r);
    for (const n of adj.get(id) ?? []) {
      indeg.set(n, (indeg.get(n) ?? 0) - 1);
      if ((indeg.get(n) ?? 0) <= 0 && !done.has(n)) queue.push(n);
    }
  }
  return { order, cycleIds: new Set(rules.filter((r) => !done.has(r.id)).map((r) => r.id)) };
}

/** DFS 找一条循环路径（含自引用），用于发布时指出具体是哪几条规则。 */
export function findCycle(rules: LinkRule[]): string[] | null {
  const adj = buildAdj(rules);
  const color = new Map<string, number>(); // 0 未访问 / 1 递归栈中 / 2 已完成
  const stack: string[] = [];
  function dfs(id: string): string[] | null {
    color.set(id, 1);
    stack.push(id);
    for (const n of adj.get(id) ?? []) {
      if (color.get(n) === 1) {
        const i = stack.indexOf(n);
        return [...stack.slice(i), n];
      }
      if (!color.get(n)) {
        const c = dfs(n);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  }
  for (const r of rules) {
    if (!color.get(r.id)) {
      const c = dfs(r.id);
      if (c) return c;
    }
  }
  return null;
}

/** 发布前校验：循环依赖 + 指向已移除字段。有问题时发布必须中止。 */
export function validateDraft(fields: FormField[], rules: LinkRule[]): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const ids = new Set(fields.map((f) => f.id));
  for (const r of rules) {
    const missing = [r.fieldId, r.targetId].filter((id) => !ids.has(id));
    if (missing.length) {
      issues.push({ ruleId: r.id, type: 'dangling', message: `规则 ${r.id} 引用了已移除的字段：${missing.join('、')}` });
    }
  }
  const cycle = findCycle(rules);
  if (cycle) {
    const self = cycle.length === 2 && cycle[0] === cycle[1];
    issues.push({
      ruleId: cycle[0],
      type: 'cycle',
      message: self
        ? `规则 ${cycle[0]} 的条件字段与目标字段相同，自引用形成环`
        : `规则 ${cycle.join(' → ')} 相互引用形成循环依赖，无法确定生效顺序`,
    });
  }
  return issues;
}

function condTrue(r: LinkRule, v: unknown): boolean {
  const s = v == null ? '' : String(v);
  return r.operator === 'notEmpty' ? s.trim() !== '' : s === r.value;
}

/**
 * 按依赖先后求解决定字段的可见/必填状态。
 * 拓扑序保证读取某字段前，作用于它的规则都已计算完：
 * 上游答案改动后，下游结果先随字段隐藏而作废（按空值处理），再按序重算。
 */
export function evaluateStates(fields: FormField[], rules: LinkRule[], values: Record<string, unknown>): Record<string, FieldState> {
  const ids = new Set(fields.map((f) => f.id));
  const states: Record<string, FieldState> = {};
  for (const f of fields) states[f.id] = { visible: true, required: f.required };
  const showTargets = new Set<string>();
  const shownByAny = new Set<string>();
  const { order } = topoSortRules(rules);
  for (const r of order) {
    if (!ids.has(r.fieldId) || !ids.has(r.targetId)) continue; // 悬空规则不参与计算
    const sourceVisible = !showTargets.has(r.fieldId) || shownByAny.has(r.fieldId);
    const v = sourceVisible ? values[r.fieldId] : ''; // 被隐藏的字段按空值处理，下游联动随之作废
    if (r.effect === 'show') {
      showTargets.add(r.targetId);
      if (condTrue(r, v)) shownByAny.add(r.targetId);
    } else if (r.effect === 'require' && condTrue(r, v)) {
      states[r.targetId].required = true;
    }
  }
  for (const id of showTargets) {
    if (states[id]) states[id].visible = shownByAny.has(id);
  }
  return states;
}

export interface VersionInterpretation {
  notes: string[];
  states: Record<string, FieldState>;
}

/** 按某个历史版本自身的规则解释当时提交的数据——规则冻结，不随升级改变。 */
export function interpretVersion(version: { fields: FormField[]; rules: LinkRule[] }, data: Record<string, unknown>): VersionInterpretation {
  const states = evaluateStates(version.fields, version.rules, data);
  const labels = new Map(version.fields.map((f) => [f.id, f.label]));
  const notes: string[] = [];
  for (const r of topoSortRules(version.rules).order) {
    if (!labels.has(r.fieldId) || !labels.has(r.targetId)) continue;
    const sourceVisible = !states[r.fieldId] || states[r.fieldId].visible;
    const v = sourceVisible ? (data[r.fieldId] ?? '') : '';
    if (!condTrue(r, v)) continue;
    const effect = r.effect === 'require' ? '必填' : '显示';
    notes.push(`规则 ${r.id} 生效：${labels.get(r.fieldId)} ${r.operator === 'equals' ? `等于「${r.value}」` : '非空'} → ${effect}「${labels.get(r.targetId)}」`);
  }
  return { notes, states };
}
