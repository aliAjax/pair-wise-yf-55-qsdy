import { evaluate, buildRuntimeSchema } from '../src/engine';
import type { FormVersion } from '../src/store';

const version = {
  id: 'v2', label: 'v2', createdAt: '2026-09-28',
  fields: [
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'costCenter', label: '成本中心', type: 'text', required: false },
    { id: 'costNote', label: '成本说明', type: 'text', required: false },
    { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
    { id: 'amount', label: '申请金额', type: 'number', required: true },
    { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
  ],
  rules: [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
    { id: 'r5', fieldId: 'department', operator: 'equals', value: '财务', effect: 'setValue', targetId: 'costCenter', resultValue: 'FIN-03' },
    { id: 'r6', fieldId: 'costCenter', operator: 'notEmpty', value: '', effect: 'show', targetId: 'costNote' }
  ]
} as FormVersion;

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// 财务部门：budgetCode 条件必填，缺失时报错并定位到 budgetCode
const outcome1 = evaluate(version, { department: '财务', amount: '100' });
const fail = buildRuntimeSchema(version, outcome1).safeParse({ department: '财务', amount: '100', costCenter: 'FIN-03', budgetCode: '', invoiceDate: '' });
check('财务缺预算科目 → 校验失败', fail.success, false);
if (!fail.success) check('错误定位到 budgetCode', fail.error.issues[0].path, ['budgetCode']);

// 研发部门：costNote 隐藏，即使夹带旧值提交也被 schema 剥离
const outcome2 = evaluate(version, { department: '研发', amount: '100' });
const pass = buildRuntimeSchema(version, outcome2).safeParse({ department: '研发', amount: '100', costCenter: '', budgetCode: '', invoiceDate: '', costNote: '残留旧值' });
check('研发无预算科目 → 校验通过', pass.success, true);
if (pass.success) {
  check('隐藏的 costNote 被剥离', 'costNote' in pass.data, false);
  check('可见的 invoiceDate 保留', 'invoiceDate' in pass.data, true);
}

// 选填字段缺省不报错
const pass2 = buildRuntimeSchema(version, outcome2).safeParse({ department: '研发', amount: '100' });
check('选填字段缺省 → 校验通过', pass2.success, true);

// 数字校验
const bad = buildRuntimeSchema(version, outcome2).safeParse({ department: '研发', amount: 'abc', costCenter: '', budgetCode: '', invoiceDate: '' });
check('金额非数字 → 校验失败', bad.success, false);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
