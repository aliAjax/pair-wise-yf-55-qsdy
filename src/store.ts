import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { validateDraft, type RuleIssue } from './rules';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }

interface SchemaState { versions: FormVersion[]; activeVersionId: string; previewVersionId: string; snapshots: Snapshot[]; publishIssues: RuleIssue[]; }
type RootShape = { schema: SchemaState };

const initial: SchemaState = {
  activeVersionId: 'v1',
  previewVersionId: 'v2',
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
        { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
        { id: 'amount', label: '申请金额', type: 'number', required: true },
        { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
      ]
    }
  ],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } },
    { id: 's3', versionId: 'v2', label: '品牌推广费', data: { department: '财务', name: '品牌推广', budgetCode: 'K-2026-09', amount: '88000', invoiceDate: '' } }
  ],
  publishIssues: []
};

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const from = version.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = version.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = version.fields.splice(from, 1); version.fields.splice(to, 0, moved);
    },
    addField(state) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const id = `field-${Date.now()}`;
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      version.rules.push({ ...action.payload, id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
      state.publishIssues = []; // 草稿已改动，撤下上次发布的拦截提示
    },
    removeRule(state, action: PayloadAction<string>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      version.rules = version.rules.filter((item) => item.id !== action.payload);
      state.publishIssues = [];
    },
    publishVersion(state) {
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      // 发布前校验：成环 / 引用被移除字段时中止，草稿原样保留，可继续修改
      const issues = validateDraft(source.fields, source.rules);
      if (issues.length) {
        state.publishIssues = issues;
        return;
      }
      const nextNum = state.versions.reduce((max, v) => {
        const n = Number.parseInt(v.id.replace(/^v/, ''), 10);
        return Number.isNaN(n) ? max : Math.max(max, n);
      }, 0) + 1;
      const id = `v${nextNum}`;
      const clone = JSON.parse(JSON.stringify(source)) as FormVersion;
      state.versions.push({ ...clone, id, label: `费用申请 ${id}`, createdAt: new Date().toISOString().slice(0, 10) });
      state.activeVersionId = id; state.previewVersionId = id;
      state.publishIssues = [];
    },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; state.publishIssues = []; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return { ...action.payload, publishIssues: [] }; }
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
export const { addField, addRule, publishVersion, reorderFields, removeRule, replaceState, selectPreview } = slice.actions;
export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;
