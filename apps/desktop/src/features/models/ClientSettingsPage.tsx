import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Model, type ModelInput } from "../../shared/api";
import { CursorModelCards, cursorModelGroups, type CursorModelGroup, type CursorModelGrouping } from "./CursorModelCards";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { addIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { isZcodePluginReady } from "../../shared/utils/zcodeEnvironment";
import { isOpencodePluginReady } from "../../shared/utils/opencodeEnvironment";

export type ClientTarget = "claude" | "codex";

type ClientSettingsPageProps = {
  client: ClientTarget;
};

export function ClientSettingsPage({ client }: ClientSettingsPageProps) {
  const { claudeHarness, codexHarness, plugins } = useAppStore();
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [grouping, setGrouping] = useState<CursorModelGrouping>("flat");
  const [settingsGroup, setSettingsGroup] = useState<CursorModelGroup | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const [confirmDisableTakeover, setConfirmDisableTakeover] = useState(false);
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());

  const isClaude = client === "claude";
  const clientName = isClaude ? "Claude CLI" : "Codex Desktop";
  const harness = isClaude ? claudeHarness : codexHarness;
  const takenOver = harness?.settings_applied ?? false;
  const takeoverLabel = takenOver ? t("关闭接管 {name}", { name: clientName }) : t("开启接管 {name}", { name: clientName });

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.clientModels(client);
      setModels(list);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [client, message]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const testTargets = models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name }));
  const providerGroups = cursorModelGroups(models, "provider");
  const typeGroups = cursorModelGroups(models, "type");
  const canGroupByProvider = providerGroups.length > 1;
  const canGroupByType = typeGroups.length > 1;

  useEffect(() => {
    if ((grouping === "provider" && !canGroupByProvider) || (grouping === "type" && !canGroupByType)) {
      setGrouping("flat");
    }
  }, [canGroupByProvider, canGroupByType, grouping]);

  const openNew = () => {
    const next = emptyCursorModelDraft();
    next.model.sort_order = models.length + 1;
    if (isClaude) {
      next.model.type = "anthropic";
      next.providerId = "builtin/anthropic";
    }
    setEditing(null);
    setModelOptions([]);
    setDraft(next);
  };

  const openEdit = (model: Model) => {
    setEditing(model);
    setModelOptions([model.model_id]);
    setDraft({
      providerId: `builtin/${model.type}`,
      model: modelInput(model),
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: JSON.stringify(model.custom_headers, null, 2),
      anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  };

  const discover = async (): Promise<boolean> => {
    if (!draft) return false;
    setDiscovering(true);
    try {
      const custom_headers = parseHeaders(draft.customHeadersText);
      const result = await api.discoverModels({
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers,
      });
      setModelOptions([...new Set(result.models)]);
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };

  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = draftInput(draft);
    let result: Model | null = null;
    if (editing) {
      result = await api.updateClientModel(client, editing.model_hash, input);
    } else {
      const created = await api.createClientModels(client, [input]);
      result = created[0] ?? null;
    }
    await loadModels();
    await appStore.refresh();
    return result;
  };

  const save = async () => {
    try {
      if (await persist()) {
        message(t("模型已保存，接管状态下自动同步至 {name}", { name: clientName }), { duration: 3000 });
        setDraft(null);
        setEditing(null);
      }
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const cancelModelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(t("取消测试失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };

  const cancelAllModelTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelModelTest(modelHash)));
  };

  const testModel = async (model: { model_hash: string; display_name: string }, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testClientModel(client, model.model_hash, active.testId, active.controller.signal);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(t("模型 {model} 连通性测试成功（{duration} ms）", { model: model.display_name, duration: result.duration_ms }));
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return "cancelled";
      }
      const error = errorText(cause);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(t("连通性测试失败：{error}", { error }), { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };

  const saveAndTest = async () => {
    setSavingAndTesting(true);
    let saved: Model | null = null;
    try {
      saved = await persist();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingAndTesting(false);
    }
    if (!saved) return;
    setEditing(saved);
    await testModel(saved);
  };

  const testAllModels = async () => {
    if (!testTargets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(testTargets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? t("连通性测试已取消：成功 {successful}，失败 {failed}", { successful, failed })
        : failed === 0
          ? t("全部 {count} 个模型连通性测试成功", { count: testTargets.length })
          : t("连通性测试完成：成功 {successful}，失败 {failed}", { successful, failed }),
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };

  const duplicateModel = async (model: Model) => {
    const names = new Set(models.map((item) => item.display_name));
    const baseName = t("{name} 副本", { name: model.display_name });
    let displayName = baseName;
    let suffix = 2;
    while (names.has(displayName)) {
      displayName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    const created = await api.createClientModels(client, [{
      ...modelInput(model),
      sort_order: models.length + 1,
      display_name: displayName,
    }]);
    if (created) {
      message(t("模型已复制"));
      await loadModels();
    }
  };

  const openGroupSettings = (group: CursorModelGroup) => {
    setSettingsGroup(group);
    setGroupNameDraft(sharedValue(group.models.map((item) => item.group_name ?? "")) ?? "");
    setGroupBaseUrlDraft(sharedValue(group.models.map((item) => item.base_url)) ?? "");
    setGroupApiKeyDraft(sharedValue(group.models.map((item) => item.api_key)) ?? "");
  };

  const saveGroupSettings = async () => {
    if (!settingsGroup) return;
    setGroupSettingsBusy(true);
    try {
      const updates = settingsGroup.models.map((model) => {
        const next: ModelInput = { ...modelInput(model) };
        if (groupNameDraft.trim()) next.group_name = groupNameDraft.trim();
        else if (groupNameDraft === "") next.group_name = null;
        if (groupBaseUrlDraft.trim()) next.base_url = groupBaseUrlDraft.trim();
        if (groupApiKeyDraft.trim()) next.api_key = groupApiKeyDraft.trim();
        return api.updateClientModel(client, model.model_hash, next);
      });
      await Promise.all(updates);
      message(t("分组设置已保存"));
      setSettingsGroup(null);
      await loadModels();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setGroupSettingsBusy(false);
    }
  };

  const applyTakeover = async (enabled: boolean, terminateProcess = false) => {
    try {
      if (isClaude) await appStore.setClaudeEnabled(enabled);
      else await appStore.setCodexEnabled(enabled, terminateProcess);
      message(enabled ? t("{name} 已接管", { name: clientName }) : t("{name} 已恢复默认配置", { name: clientName }));
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const toggleTakeover = async (enabled: boolean) => {
    if (enabled && models.length === 0) {
      message(t("请先添加至少一个模型配置后再开启接管"));
      return;
    }
    if (!enabled && !isClaude) {
      try {
        const { running } = await api.codexRunning();
        if (running) {
          setConfirmDisableTakeover(true);
          return;
        }
      } catch {
        // ignore check failure
      }
    }
    await applyTakeover(enabled);
  };

  const list = <CursorModelCards
    models={models}
    grouping={grouping}
    disabled={loading}
    testingModelHashes={testingModelHashes}
    testResults={modelTestResults}
    onTest={(model) => void testModel(model)}
    onEdit={openEdit}
    onDuplicate={(model) => void duplicateModel(model)}
    onDelete={setDeleting}
    onReorder={(hashes) => {
      void api.reorderClientModels(client, hashes).then(() => loadModels()).catch((cause) => message(errorText(cause)));
    }}
    onGroupSettings={openGroupSettings}
  />;

  const content = <div className={styles.page}>
    {models.length > 0 ? list : (
      <div className={styles.gate}>
        <strong>{t("还没有可供 {name} 使用的模型", { name: clientName })}</strong>
        <span>{isClaude ? t("添加模型配置后即可接管 Claude CLI。") : t("添加模型配置后即可接管 Codex Desktop。")}</span>
        <div className={styles.gateActions}>
          <button className={controls.primary} disabled={loading} onClick={openNew}>{t("添加模型")}</button>
        </div>
      </div>
    )}
  </div>;

  const editorTestState = editing ? modelTestResults.get(editing.model_hash) : undefined;
  const editorTesting = Boolean(editing && testingModelHashes.has(editing.model_hash));
  const activeGroups = grouping === "provider" ? providerGroups : typeGroups;
  const estimatedModelHeight = grouping === "flat"
    ? Math.max(380, Math.ceil(models.length / 3) * 196)
    : Math.max(380, activeGroups.reduce((height, group) => height + 60 + group.models.length * 56, 0) + Math.max(0, activeGroups.length - 1) * 20);

  return <>
    <PageActions position="left">
      <div className={styles.takeoverActions}>
        <span className={styles.takeoverStatus}>{takenOver ? t("已接管") : t("未接管")}</span>
        <TooltipTrigger label={takeoverLabel}>
          <Switch
            checked={takenOver}
            disabled={loading}
            label={takeoverLabel}
            onChange={(enabled) => void toggleTakeover(enabled)}
          />
        </TooltipTrigger>
        {testTargets.length > 0 && <>
          <span className={styles.actionDivider} aria-hidden="true" />
          <div className={styles.groupActions} role="group" aria-label={t("操作")}>
            <button type="button" aria-pressed={grouping === "flat"} onClick={() => setGrouping("flat")}>{t("默认平铺")}</button>
            {canGroupByProvider && <button type="button" aria-pressed={grouping === "provider"} onClick={() => setGrouping("provider")}>{t("按供应商")}</button>}
            {canGroupByType && <button type="button" aria-pressed={grouping === "type"} onClick={() => setGrouping("type")}>{t("按类型")}</button>}
          </div>
          <button className={styles.batchAction} type="button" disabled={loading || (!batchTesting && testingModelHashes.size > 0)} onClick={() => void (batchTesting ? cancelAllModelTests() : testAllModels())}>{batchTesting ? t("取消全部测试") : t("一键测试")}</button>
        </>}
      </div>
    </PageActions>
    <PageActions><TooltipTrigger label={t("添加模型")}><button className={`${controls.iconButton} ${styles.toolbarIcon}`} aria-label={t("添加模型")} disabled={loading} onClick={openNew}><Icon icon={addIcon} size="1.1em" /></button></TooltipTrigger></PageActions>
    <PageContent sections={[
      { key: `${client}-settings`, estimatedHeight: estimatedModelHeight + 120, content },
    ]} />
    <Modal fullHeight open={draft !== null} title={editing ? t("编辑模型") : t("添加模型")} banner={draft && (editorTesting || editorTestState) ? <CursorModelTestResult state={editorTestState} testing={editorTesting} /> : undefined} busy={loading || savingAndTesting} onClose={() => { if (editing && editorTesting) void cancelModelTest(editing.model_hash); setDraft(null); setEditing(null); }} onSubmit={() => void save()} submitLabel={t("保存")} secondaryAction={<button type="button" className={controls.secondary} disabled={loading || savingAndTesting} onClick={() => void (editorTesting && editing ? cancelModelTest(editing.model_hash) : saveAndTest())}>{savingAndTesting ? t("处理中…") : editorTesting ? t("取消测试") : t("保存并测试")}</button>}>
      {draft && <>
        <CursorModelEditor
          draft={draft}
          modelOptions={modelOptions}
          discovering={discovering}
          zcodePluginReady={isZcodePluginReady(plugins)}
          opencodePluginReady={isOpencodePluginReady(plugins)}
          target={client}
          onChange={setDraft}
          onDiscover={discover}
        />
      </>}
    </Modal>
    <Modal open={settingsGroup !== null} title={t("分组设置")} busy={groupSettingsBusy || loading} onClose={() => setSettingsGroup(null)} onSubmit={() => void saveGroupSettings()} submitLabel={t("保存")}>
      {settingsGroup && <div className={styles.editor}>
        <FormField label={t("分组名称")} hint={t("应用于该分组下的全部模型；清空则恢复显示服务器域名。")}>
          <TextInput placeholder={t("留空保持不变")} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
        </FormField>
        <FormField label={t("服务器地址")} hint={t("修改后应用于该分组下的全部模型；留空保持各模型现有配置不变。")}>
          <TextInput placeholder={t("留空保持不变")} value={groupBaseUrlDraft} onChange={(event) => setGroupBaseUrlDraft(event.target.value)} />
        </FormField>
        <FormField label="API Key" hint={t("修改后应用于该分组下的全部模型；留空保持各模型现有配置不变。")}>
          <SecretTextInput placeholder={t("留空保持不变")} autoComplete="off" value={groupApiKeyDraft} onChange={(event) => setGroupApiKeyDraft(event.target.value)} />
        </FormField>
      </div>}
    </Modal>
    <ConfirmDialog open={deleting !== null} title={t("删除模型")} cancelLabel={t("取消")} confirmLabel={t("删除")} onCancel={() => setDeleting(null)} onConfirm={() => {
      if (deleting) {
        void api.deleteClientModel(client, deleting.model_hash).then(() => loadModels()).catch((cause) => message(errorText(cause)));
      }
      setDeleting(null);
    }}><p>{t("确定删除这个模型吗？")}</p></ConfirmDialog>
    {!isClaude && (
      <ConfirmDialog
        open={confirmDisableTakeover}
        title={t("关闭接管 {name}？", { name: clientName })}
        cancelLabel={t("否")}
        confirmLabel={t("是")}
        onCancel={() => setConfirmDisableTakeover(false)}
        onConfirm={() => {
          setConfirmDisableTakeover(false);
          void applyTakeover(false, true);
        }}
      >
        <p>{t("检测到 {name} 正在运行，关闭接管将会退出该应用。是否确认关闭接管并退出？", { name: clientName })}</p>
      </ConfirmDialog>
    )}
  </>;
}

function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

function sharedValue(values: string[]): string | null {
  const [first, ...rest] = values;
  if (first === undefined) return null;
  return rest.every((value) => value === first) ? first : null;
}

function draftInput(draft: CursorModelDraft): ModelInput {
  const model = {
    ...draft.model,
    display_name: draft.model.display_name.trim(),
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim(),
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, t("OpenAI 额外参数")),
    custom_headers: parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, t("Anthropic 额外参数")),
  };
  if (!model.display_name || !model.base_url || !model.api_key || !model.tooltip_data || !model.model_id) throw new Error(t("服务器地址或完整请求 URL、API Key、模型名称、显示名称和备注不能为空"));
  for (const [label, value] of [[t("上下文窗口 Token"), model.context_window_tokens], [t("最大输出 Token"), model.type === "openai" ? model.max_completion_tokens : model.anthropic_max_tokens], [t("思考预算 Token"), model.thinking_budget_tokens]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(t("{label} 必须是大于 0 的整数", { label }));
  }
  return model;
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, t("自定义 Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("自定义 Headers 的值必须都是字符串"));
  return parsed as Record<string, string>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
