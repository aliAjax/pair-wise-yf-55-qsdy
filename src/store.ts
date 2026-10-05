import { configureStore, createSlice, current, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { validateRules, type RuleIssue } from './engine';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule {
  id: string;
  fieldId: string;
  operator: 'equals' | 'notEmpty' | 'gt';
  value: string;
  effect: 'show' | 'require' | 'setValue';
  targetId: string;
  /** effect 为 setValue 时命中后写入目标字段的值 */
  resultValue?: string;
}
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }

interface SchemaState {
  versions: FormVersion[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
  /** 上一次发布被拦下的原因；为空表示可以发布 */
  publishIssues: RuleIssue[];
}
type RootShape = { schema: SchemaState };

const initial: SchemaState = {
  activeVersionId: 'v1',
  previewVersionId: 'v2',
  publishIssues: [],
  versions: [
    {
      id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12',
      fields: [
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'amount', label: '申请金额', type: 'number', required: true }
      ], rules: []
    },
    {
      id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28',
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
    }
  ],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
  ]
};

function draftVersion(state: SchemaState): FormVersion | undefined {
  return state.versions.find((item) => item.id === state.previewVersionId);
}

/** 生成会话内唯一的业务对象 id，避免同毫秒连发时撞号 */
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const version = draftVersion(state);
      if (!version) return;
      const from = version.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = version.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = version.fields.splice(from, 1); version.fields.splice(to, 0, moved);
    },
    addField(state) {
      const version = draftVersion(state);
      if (!version) return;
      const id = uid('field');
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
      state.publishIssues = [];
    },
    removeField(state, action: PayloadAction<string>) {
      const version = draftVersion(state);
      if (!version) return;
      // 只移除字段本身：仍引用它的规则会留下来，发布校验会拦下并指出来
      version.fields = version.fields.filter((item) => item.id !== action.payload);
      state.publishIssues = [];
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const version = draftVersion(state);
      if (!version) return;
      version.rules.push({ ...action.payload, id: uid('rule') });
      state.publishIssues = [];
    },
    removeRule(state, action: PayloadAction<string>) {
      const version = draftVersion(state);
      if (!version) return;
      version.rules = version.rules.filter((item) => item.id !== action.payload);
      state.publishIssues = [];
    },
    publishVersion(state) {
      const source = draftVersion(state);
      if (!source) return;
      // 发布前校验：规则成环或指向已移除字段时停下，草稿留在原地继续改
      const issues = validateRules(current(source));
      if (issues.length > 0) {
        state.publishIssues = issues;
        return;
      }
      state.publishIssues = [];
      const id = `v${state.versions.length + 1}`;
      state.versions.push({ ...current(source), id, label: `费用申请 ${id}`, createdAt: new Date().toISOString().slice(0, 10) });
      state.activeVersionId = id; state.previewVersionId = id;
    },
    addSnapshot(state, action: PayloadAction<{ versionId: string; label: string; data: Record<string, string> }>) {
      state.snapshots.push({ id: uid('s'), ...action.payload });
    },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; state.publishIssues = []; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return { ...initial, ...action.payload }; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi', baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('yf55-schema-state');
        const state = raw ? JSON.parse(raw) as SchemaState : initial;
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const { addField, addRule, addSnapshot, publishVersion, removeField, removeRule, reorderFields, replaceState, selectPreview } = slice.actions;
export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;
