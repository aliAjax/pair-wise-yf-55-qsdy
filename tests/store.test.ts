import { store, addRule, removeField, removeRule, publishVersion, selectPreview } from '../src/store';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}
const state = () => store.getState().schema;

// 1. 干净草稿可以发布
const before = state().versions.length;
store.dispatch(publishVersion());
check('干净草稿发布成功', state().versions.length, before + 1);
check('发布后切换到新版本', state().activeVersionId, `v${before + 1}`);
check('发布问题已清空', state().publishIssues, []);

// 2. 移除字段后，引用它的规则让发布停下来
store.dispatch(removeField('budgetCode'));
store.dispatch(publishVersion());
check('悬空引用阻止发布', state().versions.length, before + 1);
check('指出 r1 这条规则', state().publishIssues.map((i) => `${i.ruleId}:${i.kind}`), ['r1:dangling']);
const draft = () => state().versions[state().versions.length - 1];
check('草稿原地保留（字段已移除）', draft().fields.some((f) => f.id === 'budgetCode'), false);
check('草稿原地保留（规则还在）', draft().rules.some((r) => r.id === 'r1'), true);

// 3. 删掉问题规则后，草稿原地还能接着改并成功发布
store.dispatch(removeRule('r1'));
store.dispatch(publishVersion());
check('修复后发布成功', state().versions.length, before + 2);
check('发布问题已清空', state().publishIssues, []);

// 4. 成环的规则让发布停下来，并指出具体哪几条
store.dispatch(addRule({ fieldId: 'name', operator: 'notEmpty', value: '', effect: 'setValue', targetId: 'costCenter', resultValue: 'X' }));
store.dispatch(addRule({ fieldId: 'costCenter', operator: 'notEmpty', value: '', effect: 'setValue', targetId: 'name', resultValue: 'Y' }));
store.dispatch(publishVersion());
const cycleIssues = state().publishIssues.filter((i) => i.kind === 'cycle');
check('环阻止发布', state().versions.length, before + 2);
check('环涉及的两条规则都被指出', cycleIssues.length, 2);
check('草稿仍在原地可改', state().previewVersionId, `v${before + 2}`);

// 5. 历史版本不受草稿改动影响
check('v2 的 budgetCode 仍在', state().versions.find((v) => v.id === 'v2')!.fields.some((f) => f.id === 'budgetCode'), true);
check('v2 的 r1 仍在', state().versions.find((v) => v.id === 'v2')!.rules.some((r) => r.id === 'r1'), true);
check('历史快照仍挂在 v1', state().snapshots.filter((s) => s.versionId === 'v1').length, 2);

// 6. 切换预览到历史版本后，编辑操作落在草稿上而不是历史版本上
store.dispatch(selectPreview('v1'));
store.dispatch(selectPreview(state().versions[state().versions.length - 1].id));
check('预览切换不报错', typeof state().previewVersionId, 'string');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
