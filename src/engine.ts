import { z } from 'zod';
import type { FormVersion, LinkRule } from './store';

/** 发布校验发现的问题，定位到具体规则 */
export interface RuleIssue {
  ruleId: string;
  kind: 'dangling' | 'cycle';
  detail: string;
}

export interface EvalOutcome {
  /** 作废/重算之后的最终值（隐藏字段已被清空） */
  values: Record<string, string>;
  visible: Record<string, boolean>;
  required: Record<string, boolean>;
  /** 由联动规则赋值的字段 */
  computed: string[];
  /** 本次求值中被作废清空的字段（原有值非空、结果为空） */
  invalidated: string[];
  /** 本次求值中被重算出新值的字段 */
  recomputed: string[];
}

function fieldLabel(version: FormVersion, id: string): string {
  return version.fields.find((field) => field.id === id)?.label ?? id;
}

/** 规则条件是否命中，source 为上游字段当前值 */
function ruleHits(rule: LinkRule, source: string): boolean {
  const value = source.trim();
  if (rule.operator === 'notEmpty') return value !== '';
  if (rule.operator === 'gt') {
    const left = Number(value);
    const right = Number(rule.value);
    return value !== '' && !Number.isNaN(left) && !Number.isNaN(right) && left > right;
  }
  return value === rule.value.trim();
}

/**
 * 发布前校验：
 * 1. 规则引用了已被移除的字段（来源或目标）；
 * 2. 规则相互引用形成环（Tarjan 强连通分量，含自环）。
 */
export function validateRules(version: FormVersion): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const fieldIds = new Set(version.fields.map((field) => field.id));

  for (const rule of version.rules) {
    const missing = [rule.fieldId, rule.targetId].filter((id) => !fieldIds.has(id));
    if (missing.length > 0) {
      issues.push({ ruleId: rule.id, kind: 'dangling', detail: `引用了已移除的字段：${missing.join('、')}` });
    }
  }

  const edges = new Map<string, string[]>();
  for (const rule of version.rules) {
    if (!fieldIds.has(rule.fieldId) || !fieldIds.has(rule.targetId)) continue;
    const list = edges.get(rule.fieldId) ?? [];
    list.push(rule.targetId);
    edges.set(rule.fieldId, list);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclicRuleIds = new Set<string>();
  let counter = 0;

  function strongConnect(node: string): void {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const scc: string[] = [];
      let member = '';
      do {
        member = stack.pop()!;
        onStack.delete(member);
        scc.push(member);
      } while (member !== node);
      const isCycle = scc.length > 1 || (edges.get(node) ?? []).includes(node);
      if (isCycle) {
        const inCycle = new Set(scc);
        for (const rule of version.rules) {
          if (inCycle.has(rule.fieldId) && inCycle.has(rule.targetId)) cyclicRuleIds.add(rule.id);
        }
      }
    }
  }
  for (const id of fieldIds) {
    if (!index.has(id)) strongConnect(id);
  }

  for (const ruleId of cyclicRuleIds) {
    const rule = version.rules.find((item) => item.id === ruleId)!;
    issues.push({
      ruleId,
      kind: 'cycle',
      detail: `规则相互引用形成环：${fieldLabel(version, rule.fieldId)} → ${fieldLabel(version, rule.targetId)}`
    });
  }
  return issues;
}

/**
 * 字段的依赖先后顺序（Kahn 拓扑排序）。
 * 草稿里残留的环按字段原顺序追加在末尾，保证运行态求值总能终止。
 */
export function dependencyOrder(version: FormVersion): string[] {
  const ids = version.fields.map((field) => field.id);
  const known = new Set(ids);
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacent = new Map<string, string[]>();
  for (const rule of version.rules) {
    if (!known.has(rule.fieldId) || !known.has(rule.targetId) || rule.fieldId === rule.targetId) continue;
    const list = adjacent.get(rule.fieldId) ?? [];
    if (!list.includes(rule.targetId)) {
      list.push(rule.targetId);
      adjacent.set(rule.fieldId, list);
      indegree.set(rule.targetId, (indegree.get(rule.targetId) ?? 0) + 1);
    }
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    order.push(node);
    for (const next of adjacent.get(node) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

/**
 * 运行态求值：按依赖先后逐字段结算。
 * 上游变化时，依赖它的下游赋值先作废（清空）再按当前条件重算；
 * 被隐藏的字段一并清空，旧值不会留在结果里被提交。
 */
export function evaluate(version: FormVersion, input: Record<string, string>): EvalOutcome {
  const values: Record<string, string> = {};
  const visible: Record<string, boolean> = {};
  const required: Record<string, boolean> = {};
  for (const field of version.fields) {
    values[field.id] = input[field.id] ?? '';
    visible[field.id] = true;
    required[field.id] = field.required;
  }

  const computedTargets = new Set<string>();
  for (const rule of version.rules) {
    if (rule.effect === 'setValue') computedTargets.add(rule.targetId);
    if (rule.effect === 'show') visible[rule.targetId] = false; // 有显示规则的字段默认隐藏，命中才显示
  }

  const bySource = new Map<string, LinkRule[]>();
  for (const rule of version.rules) {
    const list = bySource.get(rule.fieldId) ?? [];
    list.push(rule);
    bySource.set(rule.fieldId, list);
  }

  // 同一目标可能被多条赋值规则命中，按规则顺序最后命中者生效
  const setValueHits = new Map<string, string>();
  for (const fieldId of dependencyOrder(version)) {
    // 轮到该字段时，它的上游都已结算完毕：先作废旧值，再写入重算结果
    if (computedTargets.has(fieldId)) values[fieldId] = setValueHits.get(fieldId) ?? '';
    for (const rule of bySource.get(fieldId) ?? []) {
      const hit = ruleHits(rule, values[rule.fieldId] ?? '');
      if (!hit) continue;
      if (rule.effect === 'show') visible[rule.targetId] = true;
      else if (rule.effect === 'require') required[rule.targetId] = true;
      else setValueHits.set(rule.targetId, rule.resultValue ?? '');
    }
  }

  // 隐藏字段的旧值作废，不随表单提交
  for (const field of version.fields) {
    if (!visible[field.id]) values[field.id] = '';
  }

  const invalidated: string[] = [];
  const recomputed: string[] = [];
  for (const field of version.fields) {
    const before = input[field.id] ?? '';
    const after = values[field.id];
    if (before !== '' && after === '') invalidated.push(field.id);
    else if (before !== after && computedTargets.has(field.id)) recomputed.push(field.id);
  }

  return { values, visible, required, computed: [...computedTargets], invalidated, recomputed };
}

/** 按当前可见/必填状态动态生成提交校验 schema，隐藏字段不参与校验 */
export function buildRuntimeSchema(version: FormVersion, outcome: EvalOutcome) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of version.fields) {
    if (!outcome.visible[field.id]) continue;
    const base = z.string();
    // 选填字段允许缺省，不会因缺少键而误报
    let schema: z.ZodTypeAny = outcome.required[field.id] ? base.min(1, `请填写${field.label}`) : base.optional();
    if (field.type === 'number') {
      schema = schema.refine((value: unknown) => value === undefined || value === '' || !Number.isNaN(Number(value)), `${field.label}必须是数字`);
    }
    shape[field.id] = schema;
  }
  return z.object(shape);
}

/** 规则的人类可读描述，用于规则列表和发布错误提示 */
export function describeRule(version: FormVersion, rule: LinkRule): string {
  const source = fieldLabel(version, rule.fieldId);
  const target = fieldLabel(version, rule.targetId);
  const condition =
    rule.operator === 'notEmpty' ? '非空' : rule.operator === 'gt' ? `大于 ${rule.value}` : `等于「${rule.value}」`;
  const effect =
    rule.effect === 'show' ? `显示「${target}」` : rule.effect === 'require' ? `要求填写「${target}」` : `将「${target}」置为「${rule.resultValue ?? ''}」`;
  return `当「${source}」${condition}时，${effect}`;
}
