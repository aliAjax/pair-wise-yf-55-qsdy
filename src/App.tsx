import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DragHandleIcon from '@mui/icons-material/DragHandle';
import { Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl, Grid, IconButton, InputLabel, MenuItem, Select, Stack, Tab, Tabs, TextField, Toolbar, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { describeRule, evaluate, buildRuntimeSchema, type EvalOutcome } from './engine';
import { addField, addRule, addSnapshot, publishVersion, removeField, removeRule, reorderFields, selectPreview, useSchemaHistoryQuery, type FormField, type FormVersion, type LinkRule, type RootState } from './store';

function SortableField({ field, readOnly, onRemove }: { field: FormField; readOnly: boolean; onRemove: () => void }) {
  const sortable = useSortable({ id: field.id, disabled: readOnly });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '14px !important' }}>
        <div><Typography fontWeight={700}>{field.label}</Typography><Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}</Typography></div>
        {!readOnly && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <IconButton size="small" onClick={onRemove} aria-label="删除字段"><DeleteOutlineIcon fontSize="small" /></IconButton>
            <IconButton size="small" {...sortable.attributes} {...sortable.listeners} aria-label="拖拽排序"><DragHandleIcon fontSize="small" /></IconButton>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

/** 运行态表单：联动规则按依赖先后生效，上游改动后下游先作废再重算，隐藏字段的旧值不随单提交 */
function RuntimeForm({ version }: { version: FormVersion }) {
  const dispatch = useDispatch();
  const [notice, setNotice] = useState<{ invalidated: string[]; recomputed: string[] } | null>(null);
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(null);
  const defaults = useMemo(() => Object.fromEntries(version.fields.map((field) => [field.id, ''])), [version]);
  const outcomeRef = useRef<EvalOutcome | null>(null);
  const resolver = useMemo<Resolver<Record<string, string>>>(() => async (formValues) => {
    const currentOutcome = outcomeRef.current ?? evaluate(version, formValues);
    const parsed = buildRuntimeSchema(version, currentOutcome).safeParse(formValues);
    if (parsed.success) return { values: parsed.data as Record<string, string>, errors: {} };
    const errors: FieldErrors<Record<string, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !errors[key]) errors[key] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors };
  }, [version]);
  const form = useForm<Record<string, string>>({ defaultValues: defaults, shouldUnregister: true, resolver });
  const values = form.watch();
  const outcome = useMemo(() => evaluate(version, values), [version, values]);
  outcomeRef.current = outcome;

  const labelOf = (id: string) => version.fields.find((field) => field.id === id)?.label ?? id;

  // 把作废/重算的结果写回表单（隐藏字段已卸载，无需同步）
  useEffect(() => {
    for (const field of version.fields) {
      if (!outcome.visible[field.id]) continue;
      const next = outcome.values[field.id] ?? '';
      if ((form.getValues(field.id) ?? '') !== next) form.setValue(field.id, next);
    }
    if (outcome.invalidated.length > 0 || outcome.recomputed.length > 0) {
      setNotice({ invalidated: outcome.invalidated, recomputed: outcome.recomputed });
    }
  }, [outcome, version, form]);

  const onSubmit = form.handleSubmit((formValues) => {
    // 只提交当前可见字段：隐藏字段的旧值已经被作废，不会跟着交上去
    const data: Record<string, string> = {};
    for (const field of version.fields) {
      if (outcome.visible[field.id]) data[field.id] = formValues[field.id] ?? '';
    }
    const label = (formValues.name ?? '').trim() || `${version.label} 提交`;
    dispatch(addSnapshot({ versionId: version.id, label, data }));
    setSubmitted(data);
    setNotice(null);
  });

  return (
    <Box component="form" onSubmit={onSubmit}>
      <Stack spacing={2}>
        {version.fields.map((field) => {
          if (!outcome.visible[field.id]) return null;
          const isComputed = outcome.computed.includes(field.id);
          const error = form.formState.errors[field.id];
          const helper = error?.message ?? (isComputed ? '由联动规则自动计算' : undefined);
          if (field.type === 'select') {
            return (
              <TextField key={field.id} select fullWidth label={field.label} required={outcome.required[field.id]}
                defaultValue="" {...form.register(field.id)} error={Boolean(error)} helperText={helper}>
                <MenuItem value="">（清空选择）</MenuItem>
                {(field.options ?? []).map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
              </TextField>
            );
          }
          return (
            <TextField key={field.id} fullWidth label={field.label} required={outcome.required[field.id]}
              type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
              {...form.register(field.id)} error={Boolean(error)} helperText={helper}
              slotProps={{ input: { readOnly: isComputed }, inputLabel: field.type === 'date' ? { shrink: true } : undefined }} />
          );
        })}
        {notice && (notice.invalidated.length > 0 || notice.recomputed.length > 0) && (
          <Alert severity="warning" onClose={() => setNotice(null)}>
            上游答案已变更：
            {notice.invalidated.length > 0 ? `已作废 ${notice.invalidated.map(labelOf).join('、')} 的旧值；` : ''}
            {notice.recomputed.length > 0 ? `已按依赖顺序重算 ${notice.recomputed.map(labelOf).join('、')}。` : ''}
          </Alert>
        )}
        <Button type="submit" variant="contained">按当前版本提交</Button>
      </Stack>
      {submitted && <Alert severity="success" sx={{ mt: 2 }}>已提交（隐藏字段的旧值不随单提交）：{JSON.stringify(submitted)}</Alert>}
      <Alert severity="info" sx={{ mt: 2 }}>提交后进入「{version.label}」的历史数据，之后升级规则也不会改变它的解释。</Alert>
    </Box>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const active = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const isDraft = active.id === state.versions[state.versions.length - 1].id;
  const [tab, setTab] = useState(0);
  const [migration, setMigration] = useState<string | null>(null);
  const [ruleSourceRaw, setRuleSourceRaw] = useState('');
  const [ruleOperator, setRuleOperator] = useState<LinkRule['operator']>('equals');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleEffect, setRuleEffect] = useState<LinkRule['effect']>('show');
  const [ruleTargetRaw, setRuleTargetRaw] = useState('');
  const [ruleResult, setRuleResult] = useState('');
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(active.id);

  const ruleSource = active.fields.some((field) => field.id === ruleSourceRaw) ? ruleSourceRaw : (active.fields[0]?.id ?? '');
  const ruleTarget = active.fields.some((field) => field.id === ruleTargetRaw) ? ruleTargetRaw : (active.fields.at(-1)?.id ?? '');
  const issueRuleIds = new Set(state.publishIssues.map((issue) => issue.ruleId));

  const activeIndex = state.versions.findIndex((item) => item.id === active.id);
  const previous = activeIndex > 0 ? state.versions[activeIndex - 1] : undefined;
  const addedFields = active.fields.filter((field) => !previous?.fields.some((item) => item.id === field.id));
  const removedFields = previous?.fields.filter((field) => !active.fields.some((item) => item.id === field.id)) ?? [];
  const addedRules = active.rules.filter((rule) => !previous?.rules.some((item) => item.id === rule.id));

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }
  function addRuleHandler() {
    if (!ruleSource || !ruleTarget) return;
    dispatch(addRule({
      fieldId: ruleSource,
      operator: ruleOperator,
      value: ruleOperator === 'notEmpty' ? '' : ruleValue,
      effect: ruleEffect,
      targetId: ruleTarget,
      resultValue: ruleEffect === 'setValue' ? ruleResult : undefined
    }));
    setRuleValue(''); setRuleResult('');
  }
  function simulate(snapshotId: string) {
    const snapshot = state.snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) return;
    const missing = active.fields.filter((field) => field.required && !snapshot.data[field.id]).map((field) => field.label);
    setMigration(missing.length ? `「${snapshot.label}」缺少当前版本必填字段：${missing.join('、')}。迁移时需要补充或使用默认值。` : `「${snapshot.label}」可以直接迁移到当前版本。`);
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography><Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button></Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                <div>
                  <Typography variant="h6">字段编排</Typography>
                  <Typography variant="body2" color="text.secondary">{isDraft ? '拖动调整字段顺序，发布后成为新的历史版本。' : '历史版本只读：已提交的数据按当时版本解释，不随升级改变。'}</Typography>
                </div>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={isDraft ? 'warning' : 'default'} label={isDraft ? `草稿 · ${active.label}` : `历史版本 · ${active.label}`} />
                  {isDraft && <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>}
                </Stack>
              </Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={active.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}><Stack>{active.fields.map((field) => <SortableField key={field.id} field={field} readOnly={!isDraft} onRemove={() => dispatch(removeField(field.id))} />)}</Stack></SortableContext></DndContext>
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则</Typography>
              <Typography variant="body2" color="text.secondary" mb={2}>填写时按依赖先后生效：上游答案改动后，依赖它的下游结果先作废再重算，隐藏字段的旧值不随单提交。</Typography>
              {active.rules.length === 0 && <Typography variant="body2" color="text.secondary" mb={1}>暂无规则。</Typography>}
              {active.rules.map((rule) => (
                <Alert key={rule.id} severity={issueRuleIds.has(rule.id) ? 'error' : 'info'} sx={{ mb: 1 }}
                  action={isDraft ? <IconButton size="small" onClick={() => dispatch(removeRule(rule.id))} aria-label="删除规则"><DeleteOutlineIcon fontSize="small" /></IconButton> : undefined}>
                  {describeRule(active, rule)}
                </Alert>
              ))}
              {isDraft && (
                <Stack spacing={2} mt={2}>
                  <Stack direction="row" spacing={1}>
                    <FormControl size="small" fullWidth><InputLabel>上游字段</InputLabel><Select label="上游字段" value={ruleSource} onChange={(event) => setRuleSourceRaw(event.target.value)}>{active.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}</Select></FormControl>
                    <FormControl size="small" sx={{ minWidth: 110 }}><InputLabel>条件</InputLabel><Select label="条件" value={ruleOperator} onChange={(event) => setRuleOperator(event.target.value as LinkRule['operator'])}><MenuItem value="equals">等于</MenuItem><MenuItem value="notEmpty">非空</MenuItem><MenuItem value="gt">大于</MenuItem></Select></FormControl>
                    {ruleOperator !== 'notEmpty' && <TextField size="small" label="条件值" value={ruleValue} onChange={(event) => setRuleValue(event.target.value)} />}
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    <FormControl size="small" sx={{ minWidth: 130 }}><InputLabel>效果</InputLabel><Select label="效果" value={ruleEffect} onChange={(event) => setRuleEffect(event.target.value as LinkRule['effect'])}><MenuItem value="show">显示字段</MenuItem><MenuItem value="require">设为必填</MenuItem><MenuItem value="setValue">赋值</MenuItem></Select></FormControl>
                    <FormControl size="small" fullWidth><InputLabel>目标字段</InputLabel><Select label="目标字段" value={ruleTarget} onChange={(event) => setRuleTargetRaw(event.target.value)}>{active.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}</Select></FormControl>
                    {ruleEffect === 'setValue' && <TextField size="small" label="结果值" value={ruleResult} onChange={(event) => setRuleResult(event.target.value)} />}
                    <Button variant="outlined" onClick={addRuleHandler} disabled={!ruleSource || !ruleTarget}>添加规则</Button>
                  </Stack>
                </Stack>
              )}
              {state.publishIssues.length > 0 && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  <Typography fontWeight={700} mb={1}>发布已停止，请先处理以下规则：</Typography>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {state.publishIssues.map((issue) => {
                      const rule = active.rules.find((item) => item.id === issue.ruleId);
                      return <li key={`${issue.ruleId}-${issue.kind}`}><Typography variant="body2">{rule ? describeRule(active, rule) : issue.ruleId}：{issue.detail}</Typography></li>;
                    })}
                  </ul>
                  <Typography variant="body2" mt={1}>草稿已保留在原地，修正后可重新发布。</Typography>
                </Alert>
              )}
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}><Tab label="版本差异" /><Tab label={t('simulate')} /><Tab label={t('runtime')} /></Tabs>
              {tab === 0 && (
                <Box mt={2}>
                  <Stack direction="row" gap={1} flexWrap="wrap" mb={2}>
                    {state.versions.map((version, index) => (
                      <Chip key={version.id} onClick={() => dispatch(selectPreview(version.id))} color={version.id === active.id ? 'primary' : 'default'}
                        label={`${version.label}${index === state.versions.length - 1 ? ' · 草稿' : ''}${version.id === state.activeVersionId ? ' · 已发布' : ''}`} />
                    ))}
                  </Stack>
                  <Typography fontWeight={700} mb={1}>{previous ? `${previous.label} → ${active.label}` : `${active.label}（首个版本）`}</Typography>
                  <Stack direction="row" gap={1} flexWrap="wrap">
                    {addedFields.map((field) => <Chip key={field.id} label={`新增 ${field.label}`} color="success" variant="outlined" />)}
                    {removedFields.map((field) => <Chip key={field.id} label={`移除 ${field.label}`} color="error" variant="outlined" />)}
                    {addedRules.length > 0 && <Chip label={`新增规则 ${addedRules.length} 条`} color="info" variant="outlined" />}
                    {previous && addedFields.length === 0 && removedFields.length === 0 && addedRules.length === 0 && <Typography variant="body2" color="text.secondary">与上一版本一致。</Typography>}
                  </Stack>
                  <Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据不会按新字段含义重新解释。</Alert>
                  <Typography mt={2} fontWeight={700}>最近历史版本</Typography>
                  {history.map((version) => <Typography key={version.id} variant="body2" color="text.secondary">{version.label} · {version.createdAt}</Typography>)}
                </Box>
              )}
              {tab === 1 && (
                <Box mt={2}>
                  <Typography fontWeight={700} mb={1}>已提交的历史数据</Typography>
                  <Typography variant="body2" color="text.secondary" mb={2}>每条数据按提交时的版本规则解释，不随升级改变。</Typography>
                  {state.snapshots.map((snapshot) => {
                    const snapVersion = state.versions.find((version) => version.id === snapshot.versionId);
                    return (
                      <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                          <Typography fontWeight={700}>{snapshot.label}</Typography>
                          <Chip size="small" label={`按 ${snapVersion?.label ?? snapshot.versionId} 解释`} />
                        </Stack>
                        {Object.entries(snapshot.data).map(([fieldId, value]) => (
                          <Typography key={fieldId} variant="body2" color="text.secondary">
                            {snapVersion?.fields.find((field) => field.id === fieldId)?.label ?? fieldId}：{value}
                          </Typography>
                        ))}
                        <Button size="small" sx={{ mt: 1 }} onClick={() => simulate(snapshot.id)}>模拟迁移到当前版本</Button>
                      </Card>
                    );
                  })}
                  {migration && <Alert severity={migration.includes('缺少') ? 'warning' : 'success'}>{migration}</Alert>}
                </Box>
              )}
              {tab === 2 && (
                <Box mt={2}>
                  <Stack direction="row" spacing={1} alignItems="center" mb={2}>
                    <Typography fontWeight={700}>运行态表单</Typography>
                    <Chip size="small" color={isDraft ? 'warning' : 'default'} label={`${active.label}${isDraft ? ' · 草稿预览' : ''}`} />
                  </Stack>
                  <RuntimeForm key={active.id} version={active} />
                </Box>
              )}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
