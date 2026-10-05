import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl, Grid, IconButton, InputLabel, MenuItem, Select, Stack, Tab, Tabs, TextField, Toolbar, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import { addField, addRule, publishVersion, reorderFields, removeRule, selectPreview, useSchemaHistoryQuery, type FormField, type LinkRule, type RootState } from './store';
import { evaluateStates, interpretVersion, topoSortRules, validateDraft, type FieldState } from './rules';

function SortableField({ field }: { field: FormField }) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '14px !important' }}>
        <div><Typography fontWeight={700}>{field.label}</Typography><Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}</Typography></div>
        <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
      </CardContent>
    </Card>
  );
}

function ruleLabel(r: LinkRule, fields: FormField[]) {
  const name = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  return `${name(r.fieldId)} ${r.operator === 'equals' ? `等于「${r.value}」` : '非空'} 时，${r.effect === 'require' ? '要求必填' : '显示'} ${name(r.targetId)}`;
}

const emptyDraftRule = (fields: FormField[]): Omit<LinkRule, 'id'> => ({
  fieldId: fields[0]?.id ?? '', operator: 'equals', value: '财务', effect: 'require', targetId: fields[fields.length - 1]?.id ?? ''
});

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const active = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const snapshots = state.snapshots;
  const [tab, setTab] = useState(0);
  const [migration, setMigration] = useState<string | null>(null);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(active.id);

  const [draftRule, setDraftRule] = useState<Omit<LinkRule, 'id'>>(() => emptyDraftRule(active.fields));
  useEffect(() => {
    if (!active.fields.some((f) => f.id === draftRule.fieldId)) setDraftRule((d) => ({ ...d, fieldId: active.fields[0]?.id ?? '' }));
    if (!active.fields.some((f) => f.id === draftRule.targetId)) setDraftRule((d) => ({ ...d, targetId: active.fields[0]?.id ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.fields]);

  const draftIssues = useMemo(() => validateDraft(active.fields, active.rules), [active.fields, active.rules]);
  const ruleOrder = useMemo(() => topoSortRules(active.rules).order, [active.rules]);

  // 联动按依赖拓扑顺序求解：上游答案改动 -> 下游结果先作废（隐藏字段按空值处理）再重算
  const fieldStatesRef = useRef<Record<string, FieldState>>({});
  const fieldsRef = useRef(active.fields);
  fieldsRef.current = active.fields;
  const runtimeSchema = useMemo(() => z.any().superRefine((data, ctx) => {
    const vals = (data ?? {}) as Record<string, unknown>;
    for (const f of fieldsRef.current) {
      const st = fieldStatesRef.current[f.id];
      if (st && !st.visible) continue; // 隐藏字段不校验
      const v = vals[f.id];
      const empty = v === undefined || v === null || String(v).trim() === '';
      if (f.type === 'number') {
        if (!empty && Number.isNaN(Number(v))) ctx.addIssue({ code: 'custom', path: [f.id], message: '请输入数字' });
        else if (st?.required && empty) ctx.addIssue({ code: 'custom', path: [f.id], message: '该字段为必填' });
      } else if (st?.required && empty) {
        ctx.addIssue({ code: 'custom', path: [f.id], message: '该字段为必填' });
      }
    }
  }), []);
  const resolver = useMemo(() => zodResolver(runtimeSchema), [runtimeSchema]);
  const { register, watch, setValue, handleSubmit, formState: { errors } } = useForm<Record<string, string>>({ defaultValues: {}, resolver });
  const values = watch();
  const fieldStates = useMemo(() => evaluateStates(active.fields, active.rules, values), [active.fields, active.rules, values]);
  fieldStatesRef.current = fieldStates;
  // 隐藏字段的旧值立即作废清空，避免带着旧值参与后续联动
  useEffect(() => {
    for (const [id, st] of Object.entries(fieldStates)) {
      const v = values[id];
      if (!st.visible && v !== undefined && v !== null && String(v) !== '') {
        setValue(id, '', { shouldDirty: false, shouldValidate: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldStates]);

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }
  function simulate(snapshotId: string) {
    const snapshot = snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) return;
    const snapVersion = state.versions.find((item) => item.id === snapshot.versionId);
    const missing = active.fields.filter((field) => field.required && !String(snapshot.data[field.id] ?? '').trim()).map((field) => field.label);
    const removedIds = Object.keys(snapshot.data).filter((id) => !active.fields.some((field) => field.id === id));
    const removed = removedIds.map((id) => snapVersion?.fields.find((f) => f.id === id)?.label ?? id);
    const parts: string[] = [];
    if (missing.length) parts.push(`旧数据缺少新版本必填字段：${missing.join('、')}，迁移时需要补充或使用默认值`);
    if (removed.length) parts.push(`旧数据中的 ${removed.join('、')} 在新版本已移除，迁移时对应数据丢弃`);
    setMigration(parts.length ? parts.join('；') + '。' : '旧数据可以直接迁移到当前版本。');
  }
  function onSubmit(vals: Record<string, string>) {
    const out: Record<string, unknown> = {};
    for (const f of active.fields) {
      const st = fieldStates[f.id];
      if (st && !st.visible) continue; // 隐藏字段不提交，旧值不带入提交结果
      out[f.id] = vals[f.id] ?? '';
    }
    setRuntimeResult(out);
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography><Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button></Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}><div><Typography variant="h6">字段编排</Typography><Typography variant="body2" color="text.secondary">拖动调整字段顺序，发布后成为新的历史版本。</Typography></div><Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button></Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={active.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}><Stack>{active.fields.map((field) => <SortableField key={field.id} field={field} />)}</Stack></SortableContext></DndContext>
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则</Typography>
              <Typography variant="body2" color="text.secondary" mb={1}>按依赖拓扑顺序生效：上游答案改动时，下游结果先作废再重算。规则成环或指向已移除字段时发布会被拦截。</Typography>
              {draftIssues.length > 0 && <Alert severity="warning" sx={{ mb: 1 }}>草稿存在 {draftIssues.length} 个问题，发布会被拦截：{draftIssues.map((i) => i.message).join('；')}</Alert>}
              {active.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无联动规则。</Typography>}
              {active.rules.map((rule) => {
                const issue = draftIssues.find((i) => i.ruleId === rule.id);
                return (
                  <Alert key={rule.id} severity={issue ? 'error' : 'info'} sx={{ mb: 1 }}
                    action={<IconButton size="small" onClick={() => dispatch(removeRule(rule.id))}><DeleteOutlineIcon fontSize="small" /></IconButton>}>
                    {ruleLabel(rule, active.fields)}{issue ? `（${issue.message}）` : ''}
                  </Alert>
                );
              })}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2} useFlexGap flexWrap="wrap">
                <FormControl size="small" sx={{ minWidth: 120 }}><InputLabel>条件字段</InputLabel><Select label="条件字段" value={draftRule.fieldId} onChange={(e) => setDraftRule({ ...draftRule, fieldId: e.target.value })}>{active.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}</Select></FormControl>
                <FormControl size="small" sx={{ minWidth: 100 }}><InputLabel>条件</InputLabel><Select label="条件" value={draftRule.operator} onChange={(e) => setDraftRule({ ...draftRule, operator: e.target.value as LinkRule['operator'] })}><MenuItem value="equals">等于</MenuItem><MenuItem value="notEmpty">非空</MenuItem></Select></FormControl>
                {draftRule.operator === 'equals' && <TextField size="small" label="值" value={draftRule.value} onChange={(e) => setDraftRule({ ...draftRule, value: e.target.value })} sx={{ minWidth: 100 }} />}
                <FormControl size="small" sx={{ minWidth: 110 }}><InputLabel>效果</InputLabel><Select label="效果" value={draftRule.effect} onChange={(e) => setDraftRule({ ...draftRule, effect: e.target.value as LinkRule['effect'] })}><MenuItem value="show">显示</MenuItem><MenuItem value="require">必填</MenuItem></Select></FormControl>
                <FormControl size="small" sx={{ minWidth: 120 }}><InputLabel>目标字段</InputLabel><Select label="目标字段" value={draftRule.targetId} onChange={(e) => setDraftRule({ ...draftRule, targetId: e.target.value })}>{active.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}</Select></FormControl>
                <Button variant="outlined" onClick={() => dispatch(addRule(draftRule))} disabled={!draftRule.fieldId || !draftRule.targetId}>添加联动</Button>
              </Stack>
              {state.publishIssues.length > 0 && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  <Typography fontWeight={700}>发布已中止：草稿中的联动规则存在 {state.publishIssues.length} 个问题，请就地修改后重新发布</Typography>
                  {state.publishIssues.map((issue) => <div key={issue.ruleId}>• {issue.message}</div>)}
                </Alert>
              )}
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}><Tab label="版本差异" /><Tab label={t('simulate')} /><Tab label={t('runtime')} /></Tabs>
              {tab === 0 && <Box mt={2}><Typography fontWeight={700} mb={1}>v1 → {active.label}</Typography><Stack direction="row" gap={1} flexWrap="wrap">{active.fields.map((field) => <Chip key={field.id} label={`字段 ${field.label}`} color="success" variant="outlined" />)}</Stack><Typography fontWeight={700} mt={2} mb={1}>联动规则（{active.rules.length}）</Typography>{active.rules.length === 0 ? <Typography variant="body2" color="text.secondary">当前版本无联动规则。</Typography> : active.rules.map((r) => <Chip key={r.id} label={ruleLabel(r, active.fields)} variant="outlined" sx={{ mr: 1, mb: 1 }} />)}<Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据按其提交时的规则解释，不会随新版本重新计算。</Alert><Typography mt={2} fontWeight={700}>其他历史版本</Typography>{history.map((version) => <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => dispatch(selectPreview(version.id))}>{version.label}<span>{version.createdAt}</span></Button>)}</Box>}
              {tab === 1 && <Box mt={2}><Typography fontWeight={700} mb={1}>选择旧数据快照</Typography>{snapshots.map((snapshot) => {
                const version = state.versions.find((item) => item.id === snapshot.versionId) ?? active;
                const interp = interpretVersion(version, snapshot.data);
                return (
                  <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                    <Typography>{snapshot.label}</Typography>
                    <Typography variant="body2" color="text.secondary" mb={1}>{JSON.stringify(snapshot.data)}</Typography>
                    {interp.notes.length > 0 && <Stack direction="row" gap={0.5} flexWrap="wrap" mb={1}>{interp.notes.map((note, i) => <Chip key={i} label={note} size="small" variant="outlined" />)}</Stack>}
                    <Button size="small" onClick={() => simulate(snapshot.id)}>模拟迁移到草稿</Button>
                  </Card>
                );
              })}{migration && <Alert severity={migration.includes('缺少') || migration.includes('移除') ? 'warning' : 'success'} sx={{ mt: 1 }}>{migration}</Alert>}</Box>}
              {tab === 2 && <Box component="form" mt={2} onSubmit={handleSubmit(onSubmit)}>
                <Alert severity="info" sx={{ mb: 2 }}>联动生效顺序：{ruleOrder.length ? ruleOrder.map((r) => r.id).join(' → ') : '无规则'}。上游答案变更时下游先作废再重算；隐藏字段的值会被清空且不提交。</Alert>
                <Stack spacing={2}>{active.fields.map((field) => {
                  const st = fieldStates[field.id];
                  if (st && !st.visible) return null;
                  return (
                    <TextField key={field.id} label={field.label} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                      required={st?.required ?? field.required}
                      {...register(field.id)}
                      error={Boolean(errors[field.id])}
                      helperText={errors[field.id]?.message ? String(errors[field.id]?.message) : st?.required ? '联动必填' : undefined}
                      InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
                    />
                  );
                })}<Button type="submit" variant="contained">按当前版本提交</Button></Stack>
                {runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据（已剔除隐藏字段）：{JSON.stringify(runtimeResult)}</Alert>}
                <Alert severity="info" sx={{ mt: 2 }}>历史数据按创建时版本的规则解释，不随字段新增或规则升级而改变。</Alert>
              </Box>}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
