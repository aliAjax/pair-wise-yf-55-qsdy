import { evaluate, validateRules, dependencyOrder } from '../src/engine';
import type { FormVersion } from '../src/store';

const version: FormVersion = {
  id: 'v2', label: 'v2', createdAt: '2026-09-28',
  fields: [
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'costCenter', label: '成本中心', type: 'text', required: false },
    { id: 'costNote', label: '成本说明', type: 'text', required: false },
    { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
    { id: 'amount', label: '申请金额', type: 'number', required: true },
    { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
  ],
  rules: [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
    { id: 'r3', fieldId: 'department', operator: 'equals', value: '研发', effect: 'setValue', targetId: 'costCenter', resultValue: 'RD-01' },
    { id: 'r4', fieldId: 'department', operator: 'equals', value: '市场', effect: 'setValue', targetId: 'costCenter', resultValue: 'MKT-02' },
    { id: 'r5', fieldId: 'department', operator: 'equals', value: '财务', effect: 'setValue', targetId: 'costCenter', resultValue: 'FIN-03' },
    { id: 'r6', fieldId: 'costCenter', operator: 'notEmpty', value: '', effect: 'show', targetId: 'costNote' }
  ]
};

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// 1. 依赖顺序：costCenter 依赖 department，costNote 依赖 costCenter
check('拓扑顺序 department 在 costCenter 前', dependencyOrder(version).indexOf('department') < dependencyOrder(version).indexOf('costCenter'), true);
check('拓扑顺序 costCenter 在 costNote 前', dependencyOrder(version).indexOf('costCenter') < dependencyOrder(version).indexOf('costNote'), true);

// 2. 填写 department=财务：成本中心重算为 FIN-03，成本说明显示，预算科目必填
const step1 = evaluate(version, { department: '财务', name: '测试', amount: '100' });
check('财务 → costCenter=FIN-03', step1.values.costCenter, 'FIN-03');
check('costNote 显示', step1.visible.costNote, true);
check('budgetCode 变为必填', step1.required.budgetCode, true);
check('invoiceDate 显示', step1.visible.invoiceDate, true);
check('costCenter 被重算', step1.recomputed, ['costCenter']);

// 3. 上游改动：财务 → 市场，下游先作废再重算；成本说明里的旧值保留（仍可见）
const step2 = evaluate(version, { department: '市场', name: '测试', amount: '100', costCenter: 'FIN-03', costNote: '旧说明', invoiceDate: '2026-10-01', budgetCode: 'BG-1' });
check('市场 → costCenter 重算为 MKT-02', step2.values.costCenter, 'MKT-02');
check('costNote 仍显示且旧值保留', step2.values.costNote, '旧说明');
check('budgetCode 不再必填', step2.required.budgetCode, false);

// 4. 清空上游：成本中心作废，成本说明隐藏且旧值作废不随单提交
const step3 = evaluate(version, { department: '', name: '测试', amount: '100', costCenter: 'MKT-02', costNote: '旧说明', invoiceDate: '2026-10-01' });
check('清空部门 → costCenter 作废', step3.values.costCenter, '');
check('costNote 隐藏', step3.visible.costNote, false);
check('costNote 旧值被清空', step3.values.costNote, '');
check('作废列表包含 costCenter 和 costNote', step3.invalidated.sort(), ['costCenter', 'costNote']);

// 5. 隐藏字段的旧值不随单提交：清空 amount 后 invoiceDate 隐藏且值被清空
const step4 = evaluate(version, { department: '研发', name: '测试', amount: '', invoiceDate: '2026-10-01' });
check('amount 清空 → invoiceDate 隐藏', step4.visible.invoiceDate, false);
check('invoiceDate 旧值被清空', step4.values.invoiceDate, '');
check('研发 → costCenter=RD-01', step4.values.costCenter, 'RD-01');

// 6. 发布校验：干净版本可以通过
check('干净版本无发布问题', validateRules(version), []);

// 7. 环检测：A→B、B→A 两条规则都要被指出来
const cyclic: FormVersion = {
  ...version,
  rules: [
    { id: 'c1', fieldId: 'name', operator: 'notEmpty', value: '', effect: 'setValue', targetId: 'costCenter', resultValue: 'X' },
    { id: 'c2', fieldId: 'costCenter', operator: 'notEmpty', value: '', effect: 'setValue', targetId: 'name', resultValue: 'Y' },
    { id: 'ok1', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
  ]
};
const cycleIssues = validateRules(cyclic);
check('环检测命中 c1/c2 两条', cycleIssues.filter((i) => i.kind === 'cycle').map((i) => i.ruleId).sort(), ['c1', 'c2']);
check('正常规则不被误伤', cycleIssues.some((i) => i.ruleId === 'ok1'), false);

// 8. 自环也算环
const selfLoop: FormVersion = { ...version, rules: [{ id: 's1', fieldId: 'name', operator: 'notEmpty', value: '', effect: 'require', targetId: 'name' }] };
check('自环被检测', validateRules(selfLoop).map((i) => i.ruleId), ['s1']);

// 9. 指向被移除字段的规则被指出来
const dangling: FormVersion = {
  ...version,
  fields: version.fields.filter((f) => f.id !== 'budgetCode'),
  rules: [version.rules[0], version.rules[1]]
};
const danglingIssues = validateRules(dangling);
check('悬空引用命中 r1', danglingIssues.map((i) => `${i.ruleId}:${i.kind}`), ['r1:dangling']);

// 10. 有环的草稿在运行态也能终止（降级为字段顺序）
const cyclicEval = evaluate(cyclic, { name: 'x', amount: '1' });
check('有环草稿求值能终止', typeof cyclicEval.values.name, 'string');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
