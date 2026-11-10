import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  api,
  pluginText,
  type PluginAddMethod,
  type PluginDescriptor,
  type PluginImportFile,
  type PluginModelDescriptor,
  type PluginOAuthBegin,
  type PluginProviderDescriptor,
  type PluginResourceAction,
  type PluginResourceActionCard,
  type PluginResourceActionResult,
  type PluginResourceDescriptor,
  type PluginResourceView,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import styles from "./PluginResourcePanels.module.scss";

const PAGE_SIZE = 10;

export function PluginAddPanel({ plugin, onConfigured }: { plugin: PluginDescriptor; onConfigured: () => void }) {
  return <div className={styles.panel}>
    {plugin.resources.map((resource) => <ResourceAddSection
      key={resource.type}
      plugin={plugin}
      resource={resource}
      onConfigured={onConfigured}
    />)}
    {plugin.resources.length === 0 && <span className={styles.empty}>{t("该插件不需要添加资源")}</span>}
  </div>;
}

function ResourceAddSection({ plugin, resource, onConfigured }: {
  plugin: PluginDescriptor;
  resource: PluginResourceDescriptor;
  onConfigured: () => void;
}) {
  if (plugin.id === "dev.cursorbyok.plugins.opencode-auth") {
    return <OpencodeLoginCard
      pluginId={plugin.id}
      resource={resource}
      onConfigured={onConfigured}
    />;
  }
  const hasOAuth = resource.add.length > 0;
  return <>
    {resource.add.map((method) => <OAuthMethodCard
      key={method.id}
      pluginId={plugin.id}
      resourceType={resource.type}
      method={method}
      onConfigured={onConfigured}
    />)}
    {!hasOAuth && resource.import && <ImportResourceCard
      pluginId={plugin.id}
      resource={resource}
      onConfigured={onConfigured}
    />}
  </>;
}

function ImportResourceCard({ pluginId, resource, onConfigured }: {
  pluginId: string;
  resource: PluginResourceDescriptor;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const importInput = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const entries: PluginImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      const result = await api.importPluginResources(pluginId, resource.type, entries);
      await appStore.refreshPlugins();
      if (result.modelSyncError) {
        setError(t("账号已保存，但同步模型失败：{error}", { error: result.modelSyncError }));
        return;
      }
      setSuccess(true);
      onConfigured();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSubmitting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  const submitKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.importPluginResources(pluginId, resource.type, [
        { name: "API Key", content: trimmed },
      ]);
      await appStore.refreshPlugins();
      if (result.modelSyncError) {
        setError(t("账号已保存，但同步模型失败：{error}", { error: result.modelSyncError }));
        return;
      }
      setSuccess(true);
      onConfigured();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const title = resource.import ? pluginText(resource.import.displayName, locale) : t("导入凭证");
  const description = resource.import?.description ? pluginText(resource.import.description, locale) : null;

  return <Card className={styles.methodCard}>
    <strong>{title}</strong>
    {description && <span>{description}</span>}
    <div className={styles.keyInputRow}>
      <input
        type="password"
        className={styles.keyInput}
        placeholder={t("粘贴 API Key（或导入凭证文件）")}
        value={apiKey}
        disabled={submitting}
        onChange={(event) => setApiKey(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void submitKey(); }}
      />
      <Button
        variant="primary"
        disabled={submitting || !apiKey.trim()}
        onClick={() => void submitKey()}
      >
        {submitting ? t("保存中…") : t("保存凭证")}
      </Button>
    </div>
    <div className={styles.actions}>
      <Button disabled={submitting} onClick={() => importInput.current?.click()}>
        {t("选择文件导入…")}
      </Button>
      <input
        ref={importInput}
        type="file"
        hidden
        accept={resource.import?.accept.join(",")}
        multiple={resource.import?.multiple ?? false}
        onChange={(event) => void importFiles(event.target.files)}
      />
    </div>
    {success && <span className={styles.success}>{t("账号已保存，模型目录已同步。")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

function OpencodeLoginCard({ pluginId, resource, onConfigured }: {
  pluginId: string;
  resource: PluginResourceDescriptor;
  onConfigured: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const startLogin = async () => {
    setSubmitting(true);
    setError(null);
    void api.openExternalUrl("https://opencode.ai/auth").catch(() => undefined);
    try {
      const result = await api.importPluginResources(pluginId, resource.type, [
        { name: "guest", content: "guest" },
      ]);
      await appStore.refreshPlugins();
      if (result.modelSyncError) {
        setError(t("账号已保存，但同步模型失败：{error}", { error: result.modelSyncError }));
        return;
      }
      setSuccess(true);
      onConfigured();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return <Card className={styles.methodCard}>
    <strong>{t("使用 OpenCode 账号登录")}</strong>
    <span>{t("通过官方 OpenCode 协议接入，使用 OpenCode 模型。")}</span>
    <div className={styles.actions}>
      <Button
        variant="primary"
        disabled={submitting}
        onClick={() => void startLogin()}
      >
        {submitting ? t("正在登录…") : t("开始登录")}
      </Button>
    </div>
    <small className={styles.spoofHint}>
      {t("* 采用官方 OpenCode 客户端协议伪装接入，自动注入客户端指纹与动态会话标识。")}
    </small>
    {success && <span className={styles.success}>{t("账号已保存，模型目录已同步。")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

function OAuthMethodCard({ pluginId, resourceType, method, onConfigured }: {
  pluginId: string;
  resourceType: string;
  method: PluginAddMethod;
  onConfigured: () => void;
}) {
  const { locale } = useI18n();
  const [status, setStatus] = useState<"idle" | "starting" | "polling" | "success" | "error">("idle");
  const [begun, setBegun] = useState<PluginOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  const copyCode = async (code: string) => {
    await api.copyCursorText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => { stopped.current = true; }, []);

  useEffect(() => {
    if (!begun || status !== "polling") return;
    let timer = 0;
    const poll = async (intervalMs: number) => {
      if (stopped.current) return;
      try {
        const result = await api.pluginOAuthPoll(begun.sessionId);
        if (stopped.current) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(result.pollIntervalMs), Math.max(1000, result.pollIntervalMs));
          return;
        }
        if (result.status === "completed") {
          await appStore.refreshPlugins();
          if (result.modelSyncError) {
            setStatus("error");
            setError(t("账号已保存，但同步模型失败：{error}", { error: result.modelSyncError }));
            return;
          }
          setStatus("success");
          onConfigured();
          return;
        }
        setStatus("error");
        setError(result.message || t("授权被拒绝或已失败。"));
      } catch (cause) {
        if (stopped.current) return;
        setError(errorText(cause));
        timer = window.setTimeout(() => void poll(intervalMs), Math.max(1000, intervalMs));
      }
    };
    timer = window.setTimeout(() => void poll(begun.pollIntervalMs), Math.max(1000, begun.pollIntervalMs));
    return () => window.clearTimeout(timer);
  }, [begun, onConfigured, status]);

  const start = async () => {
    setStatus("starting");
    setError(null);
    try {
      const next = await api.pluginOAuthBegin(pluginId, resourceType, method.id);
      setBegun(next);
      setStatus("polling");
      if (next.userCode) await api.copyCursorText(next.userCode).catch(() => undefined);
      await api.openExternalUrl(next.verificationUrlComplete || next.verificationUrl);
    } catch (cause) {
      setStatus("error");
      setError(errorText(cause));
    }
  };

  const userCode = begun?.userCode;
  return <Card className={styles.methodCard}>
    <strong>{pluginText(method.displayName, locale)}</strong>
    {method.description && <span>{pluginText(method.description, locale)}</span>}
    {userCode && status === "polling" && <div className={styles.deviceCode}>
      <small>{t("设备验证码")}</small>
      <button type="button" onClick={() => void copyCode(userCode)}>{userCode}</button>
      <button type="button" className={styles.copy} onClick={() => void copyCode(userCode)}>
        {copied ? t("已复制") : t("复制")}
      </button>
    </div>}
    <div className={styles.actions}>
      <Button variant="primary" disabled={status === "starting" || status === "polling"} onClick={() => void start()}>
        {status === "starting" ? t("正在申请授权码…") : status === "polling" ? t("等待网页端确认授权中…") : t("开始登录")}
      </Button>
      {begun && status === "polling" && <Button onClick={() => void api.openExternalUrl(begun.verificationUrlComplete || begun.verificationUrl)}>{t("打开授权网页")}</Button>}
    </div>
    {status === "success" && <span className={styles.success}>{t("账号已保存，模型目录已同步。")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

export function PluginSettingsPanel({ plugin }: { plugin: PluginDescriptor }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);
  const [resourceAction, setResourceAction] = useState<{
    resource: PluginResourceDescriptor;
    item: PluginResourceView;
  } | null>(null);
  const [resourceActionResult, setResourceActionResult] = useState<PluginResourceActionResult | null>(null);
  const [resourceActionError, setResourceActionError] = useState<string | null>(null);
  const modelProvider = modelProviderId ? plugin.providers.find((provider) => provider.id === modelProviderId) ?? null : null;

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
      await appStore.refreshPlugins();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const executeResourceAction = async (
    target: { resource: PluginResourceDescriptor; item: PluginResourceView },
    action: PluginResourceAction,
    input: unknown = {},
  ) => {
    const key = `action:${target.item.id}:${action.id}`;
    setBusy(key);
    setResourceActionError(null);
    try {
      const result = await api.pluginResourceAction(
        plugin.id,
        target.resource.type,
        target.item.id,
        action.id,
        input,
      );
      setResourceActionResult(result);
      await appStore.refreshPlugins();
    } catch (cause) {
      setResourceActionError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const openResourceAction = (resource: PluginResourceDescriptor, item: PluginResourceView, action: PluginResourceAction) => {
    setResourceAction({ resource, item });
    setResourceActionResult(null);
    setResourceActionError(null);
    void executeResourceAction({ resource, item }, action);
  };

  return <div className={styles.panel}>
    {plugin.providers.map((provider) => <ProviderRow
      key={provider.id}
      provider={provider}
      busy={busy !== null}
      syncing={busy === `sync:${provider.id}`}
      onManageModels={() => setModelProviderId(provider.id)}
      onSync={() => void run(`sync:${provider.id}`, async () => {
        await api.syncPluginModels(plugin.id, provider.id);
      })}
    />)}
    {plugin.resources.map((resource) => <ResourceList
      key={resource.type}
      resource={resource}
      busy={busy !== null}
      onAction={(item, action) => openResourceAction(resource, item, action)}
      onRefresh={(item) => void run(`refresh:${item.id}`, async () => {
        await api.refreshPluginResource(plugin.id, resource.type, item.id);
      })}
      onDelete={(item) => void run(`delete:${item.id}`, async () => {
        await api.deletePluginResource(plugin.id, resource.type, item.id);
      })}
    />)}
    {error && <span className={styles.error} role="alert">{error}</span>}
    {modelProvider && <ModelManagementModal
      provider={modelProvider}
      busy={busy !== null}
      onClose={() => setModelProviderId(null)}
      onSubmit={(enabledByModel, effortByModel) => {
        setModelProviderId(null);
        void run("models", async () => {
          for (const model of modelProvider.models) {
            const enabled = enabledByModel[model.id] ?? model.enabled;
            const efforts = model.reasoningEfforts ?? [];
            const defaultEffort = efforts.length > 0
              ? (model.reasoningEffort ?? (efforts.includes("high") ? "high" : efforts[0] ?? null))
              : null;
            const nextEffort = efforts.length > 0
              ? (effortByModel[model.id] ?? defaultEffort)
              : null;
            if (model.enabled !== enabled || (model.reasoningEffort ?? null) !== nextEffort) {
              await api.setPluginModelEnabled(plugin.id, modelProvider.id, model.modelId, enabled, nextEffort);
            }
          }
        });
      }}
    />}
    {resourceAction && <ResourceActionModal
      action={resourceAction.resource.actions.find((item) => item.target === "resource") ?? null}
      cardAction={resourceAction.resource.actions.find((item) => item.target === "card") ?? null}
      result={resourceActionResult}
      busy={busy !== null}
      error={resourceActionError}
      onClose={() => setResourceAction(null)}
      onCardAction={(action, card) => void executeResourceAction(resourceAction, action, { cardId: card.id })}
    />}
  </div>;
}

function ProviderRow({ provider, busy, syncing, onManageModels, onSync }: {
  provider: PluginProviderDescriptor;
  busy: boolean;
  syncing: boolean;
  onManageModels: () => void;
  onSync: () => void;
}) {
  const { locale } = useI18n();
  return <Card className={styles.providerRow}>
    <div className={styles.rowMain}>
      <div className={styles.rowTitleWrap}>
        <strong className={styles.rowTitle}>{pluginText(provider.displayName, locale)}</strong>
      </div>
      <div className={styles.rowMeta}>
        <span className={styles.rowMetaTag}>{provider.providerType}</span>
        <span className={styles.rowMetaDivider}>·</span>
        <span>
          {provider.models.length > 0 ? t("{count} 个模型", { count: provider.models.length }) : t("尚未同步模型")}
        </span>
        <span className={styles.rowMetaDivider}>·</span>
        <span className={provider.configured ? styles.metaAvailable : styles.metaPending}>
          {provider.configured ? t("可调用") : t("未就绪")}
        </span>
      </div>
    </div>
    {provider.hasModels && <div className={styles.actions}>
      <Button variant="primary" size="small" disabled={busy || provider.models.length === 0} onClick={onManageModels}>{t("模型管理")}</Button>
      <Button size="small" disabled={busy} onClick={onSync}>
        {syncing ? t("正在同步…") : t("同步模型")}
      </Button>
    </div>}
  </Card>;
}

const EFFORT_ORDER = ["low", "medium", "high", "tiered"] as const;
const ID_EFFORT_RE = /-(low|medium|high|tiered)$/i;
const NAME_EFFORT_RE = /\s*\((low|medium|high|tiered)\)$/i;

type ConsolidatedModelItem = {
  key: string;
  baseModelId: string;
  displayName: string;
  description: string | null;
  icon: string;
  efforts: string[];
  defaultEffort: string | null;
  enabled: boolean;
  members: PluginModelDescriptor[];
  variantByEffort: Record<string, PluginModelDescriptor>;
};

function consolidateProviderModels(models: PluginModelDescriptor[]): ConsolidatedModelItem[] {
  const map = new Map<string, ConsolidatedModelItem>();
  for (const model of models) {
    const idMatch = model.modelId.match(ID_EFFORT_RE);
    const nameMatch = model.displayName.match(NAME_EFFORT_RE);
    const tier = (idMatch?.[1] ?? nameMatch?.[1])?.toLowerCase() ?? null;
    const baseModelId = idMatch ? model.modelId.slice(0, -idMatch[0].length) : model.modelId;
    const displayName = model.displayName.replace(NAME_EFFORT_RE, "").trim() || model.displayName;
    const groupKey = displayName.toLowerCase();
    const slug = displayName.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
    const modelEfforts = model.reasoningEfforts ?? [];

    let group = map.get(groupKey);
    if (!group) {
      const initialEfforts = new Set<string>(modelEfforts.map((item) => item.toLowerCase()));
      const variantByEffort: Record<string, PluginModelDescriptor> = {};
      if (tier) {
        initialEfforts.add(tier);
        variantByEffort[tier] = model;
      }
      const efforts = EFFORT_ORDER.filter((item) => initialEfforts.has(item));
      group = {
        key: groupKey,
        baseModelId,
        displayName,
        description: model.description,
        icon: model.icon,
        efforts,
        defaultEffort: defaultModelEffort(efforts, model.reasoningEffort),
        enabled: model.enabled,
        members: [model],
        variantByEffort,
      };
      map.set(groupKey, group);
    } else {
      group.members.push(model);
      if (baseModelId.toLowerCase() === slug && group.baseModelId.toLowerCase() !== slug) {
        group.baseModelId = baseModelId;
      }
      if (!group.description && model.description) {
        group.description = model.description;
      }
      group.enabled = group.enabled || model.enabled;
      const merged = new Set<string>(group.efforts);
      for (const item of modelEfforts) merged.add(item.toLowerCase());
      if (tier) {
        merged.add(tier);
        group.variantByEffort[tier] = model;
      }
      const variantKeys = Object.keys(group.variantByEffort);
      const source = variantKeys.length > 1 ? new Set(variantKeys) : merged;
      group.efforts = EFFORT_ORDER.filter((item) => source.has(item));
      group.defaultEffort = defaultModelEffort(group.efforts, model.reasoningEffort ?? group.defaultEffort);
    }
  }
  return [...map.values()];
}

function defaultModelEffort(efforts: string[] | undefined, configured: string | null | undefined): string | null {
  if (!efforts || efforts.length === 0) return null;
  if (configured && efforts.includes(configured)) return configured;
  return efforts.includes("high") ? "high" : efforts[0] ?? null;
}

function formatEffortLabel(effort: string): string {
  const lower = effort.toLowerCase();
  if (lower === "xhigh") return "XHigh";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function EffortSlider({ efforts, value, disabled, onChange }: {
  efforts: string[];
  value: string | null;
  disabled: boolean;
  onChange: (effort: string) => void;
}) {
  const index = Math.max(0, efforts.indexOf(value ?? efforts[0] ?? ""));
  const max = Math.max(1, efforts.length - 1);
  const ratio = efforts.length > 1 ? index / max : 1;
  const currentLabel = value ? formatEffortLabel(value) : "";

  return <div
    className={styles.modelCardEffort}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <div className={styles.effortHeader}>
      <span className={styles.effortLabel}>{t("思考强度")}</span>
      <span className={styles.effortValue}>{currentLabel}</span>
    </div>
    <div
      className={styles.effortSliderWrap}
      style={{ "--effort-ratio": ratio } as CSSProperties}
    >
      <div className={styles.effortTrack} aria-hidden="true">
        <div className={styles.effortFill} />
        {efforts.map((effort, i) => {
          const tickRatio = efforts.length > 1 ? i / max : 1;
          return <span
            key={effort}
            className={styles.effortTick}
            data-passed={i < index || undefined}
            style={{ "--tick-ratio": tickRatio } as CSSProperties}
          />;
        })}
      </div>
      <span className={styles.effortThumb} aria-hidden="true" />
      <input
        type="range"
        className={styles.effortRange}
        min={0}
        max={max}
        step={1}
        disabled={disabled || efforts.length <= 1}
        value={index}
        aria-label={t("思考强度")}
        aria-valuetext={currentLabel}
        onChange={(event) => {
          const next = efforts[Number(event.target.value)];
          if (next) onChange(next);
        }}
      />
    </div>
  </div>;
}

function ModelAvatar({ modelId, displayName, icon }: { modelId: string; displayName: string; icon: string }) {
  const text = `${modelId} ${displayName}`;
  if (/claude/i.test(text)) {
    return <span className={styles.modelIcon} aria-hidden="true">
      <Icon icon={claudeIcon} size="1.5em" />
    </span>;
  }
  if (/\b(gpt|o1|o3|o4)\b/i.test(text)) {
    return <span className={styles.modelIcon} aria-hidden="true">
      <Icon icon={openAiIcon} size="1.5em" />
    </span>;
  }
  if (!icon) return null;
  return <img className={styles.modelIcon} src={icon} alt="" />;
}

function ModelManagementModal({ provider, busy, onClose, onSubmit }: {
  provider: PluginProviderDescriptor;
  busy: boolean;
  onClose: () => void;
  onSubmit: (enabledByModel: Record<string, boolean>, effortByModel: Record<string, string | null>) => void;
}) {
  const { locale } = useI18n();
  const message = useMessage();
  const items = useMemo(() => consolidateProviderModels(provider.models), [provider.models]);
  const [enabledByKey, setEnabledByKey] = useState<Record<string, boolean>>({});
  const [effortByKey, setEffortByKey] = useState<Record<string, string | null>>({});

  useEffect(() => {
    setEnabledByKey(Object.fromEntries(items.map((item) => [item.key, item.enabled])));
    setEffortByKey(Object.fromEntries(items.map((item) => [item.key, item.defaultEffort])));
  }, [items]);

  const setAll = (enabled: boolean) => {
    setEnabledByKey(Object.fromEntries(items.map((item) => [item.key, enabled])));
  };

  const copyModelName = async (modelName: string) => {
    try {
      await api.copyCursorText(modelName);
    } catch {
      await navigator.clipboard?.writeText(modelName).catch(() => undefined);
    }
    message(`${t("已复制")}: ${modelName}`);
  };

  const isDirty = useMemo(() => {
    return items.some((item) => {
      const currentEnabled = enabledByKey[item.key] ?? item.enabled;
      if (currentEnabled !== item.enabled) return true;
      const currentEffort = effortByKey[item.key] ?? item.defaultEffort;
      if (currentEffort !== item.defaultEffort) return true;
      return false;
    });
  }, [items, enabledByKey, effortByKey]);

  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const handleRequestClose = () => {
    if (isDirty) {
      setShowExitConfirm(true);
    } else {
      onClose();
    }
  };

  const handleSubmit = () => {
    const enabledByModel: Record<string, boolean> = {};
    const effortByModel: Record<string, string | null> = {};
    for (const item of items) {
      const groupEnabled = enabledByKey[item.key] ?? item.enabled;
      const selectedEffort = effortByKey[item.key] ?? item.defaultEffort;
      const variantEntries = Object.entries(item.variantByEffort);
      if (variantEntries.length > 1) {
        const chosenVariant = selectedEffort
          ? (item.variantByEffort[selectedEffort] ?? item.members[0])
          : item.members[0];
        for (const member of item.members) {
          enabledByModel[member.id] = groupEnabled && member.id === chosenVariant?.id;
          effortByModel[member.id] = selectedEffort;
        }
      } else {
        for (const member of item.members) {
          enabledByModel[member.id] = groupEnabled && member.modelId === item.baseModelId
            ? true
            : groupEnabled && item.members.length === 1;
          effortByModel[member.id] = selectedEffort;
        }
      }
    }
    onSubmit(enabledByModel, effortByModel);
  };

  return <>
    <Modal
      square
      open
      title={t("{name} 模型管理", { name: pluginText(provider.displayName, locale) })}
      busy={busy}
      onClose={handleRequestClose}
      onSubmit={handleSubmit}
      submitLabel={t("确定")}
    >
      <div className={styles.modelManager}>
        <div className={styles.modelToolbar}>
          <Button size="small" disabled={busy || items.length === 0} onClick={() => setAll(true)}>{t("全选")}</Button>
          <Button size="small" disabled={busy || items.length === 0} onClick={() => setAll(false)}>{t("全不选")}</Button>
        </div>
        {items.length > 0
          ? <div className={styles.modelGrid}>
            {items.map((item) => {
              const checked = enabledByKey[item.key] ?? item.enabled;
              const selectedEffort = effortByKey[item.key] ?? item.defaultEffort;
              return <Card
                key={item.key}
                className={styles.modelCard}
                data-disabled={busy || undefined}
                onClick={() => void copyModelName(item.baseModelId)}
              >
                <div className={styles.modelCardTop}>
                  <ModelAvatar modelId={item.baseModelId} displayName={item.displayName} icon={item.icon} />
                  <div className={styles.modelCardName}>
                    <span className={styles.modelCardNameText} title={item.displayName}>{item.displayName}</span>
                    <span className={styles.modelCardModelId} title={item.baseModelId}>{item.baseModelId}</span>
                    {item.description && <span className={styles.modelCardDescription} title={item.description}>{item.description}</span>}
                  </div>
                  <Switch
                    checked={checked}
                    disabled={busy}
                    label={t("启用 {model}", { model: item.displayName })}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(enabled) => setEnabledByKey((current) => ({ ...current, [item.key]: enabled }))}
                  />
                </div>
                {item.efforts.length > 0 && <EffortSlider
                  efforts={item.efforts}
                  value={selectedEffort}
                  disabled={busy}
                  onChange={(effort) => setEffortByKey((current) => ({ ...current, [item.key]: effort }))}
                />}
              </Card>;
            })}
          </div>
          : <span className={styles.empty}>{t("尚未同步模型")}</span>}
      </div>
    </Modal>
    {showExitConfirm && <Modal
      compact
      open
      title={t("未保存的更改")}
      role="alertdialog"
      busy={busy}
      initialFocus="submit"
      closeLabel={t("放弃更改")}
      submitLabel={t("保存并关闭")}
      secondaryAction={<Button size="small" onClick={() => setShowExitConfirm(false)}>{t("继续编辑")}</Button>}
      onClose={() => {
        setShowExitConfirm(false);
        onClose();
      }}
      onSubmit={() => {
        setShowExitConfirm(false);
        handleSubmit();
      }}
    >
      <p>{t("检测到您对模型配置进行了修改，是否要保存更改并关闭？")}</p>
    </Modal>}
  </>;
}

function ResourceList({ resource, busy, onAction, onRefresh, onDelete }: {
  resource: PluginResourceDescriptor;
  busy: boolean;
  onAction: (item: PluginResourceView, action: PluginResourceAction) => void;
  onRefresh: (item: PluginResourceView) => void;
  onDelete: (item: PluginResourceView) => void;
}) {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => resource.resources.filter((item) => item.displayName.toLowerCase().includes(query.trim().toLowerCase())),
    [resource.resources, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * PAGE_SIZE, Math.min(page, pageCount) * PAGE_SIZE);

  useEffect(() => setPage(1), [query]);

  return <FormField label={pluginText(resource.displayName, locale)}>
    <div className={styles.resourceSection}>
      {resource.resources.length > PAGE_SIZE && <div className={styles.toolbar}>
        <TextInput aria-label={t("搜索资源")} placeholder={t("搜索资源")} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>}
      <div className={styles.resourceList}>
        {visible.map((item) => <ResourceRow
          key={item.id}
          item={item}
          actions={resource.actions.filter((action) => action.target === "resource")}
          canRefresh={resource.canRefresh}
          disabled={busy}
          onAction={(action) => onAction(item, action)}
          onRefresh={() => onRefresh(item)}
          onDelete={() => onDelete(item)}
        />)}
        {visible.length === 0 && <span className={styles.empty}>{t("还没有资源，请先添加。")}</span>}
      </div>
      {pageCount > 1 && <div className={styles.pagination}>
        <Button size="small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{t("上一页")}</Button>
        <span>{t("第 {page} / {total} 页", { page: Math.min(page, pageCount), total: pageCount })}</span>
        <Button size="small" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>{t("下一页")}</Button>
      </div>}
    </div>
  </FormField>;
}

function ResourceRow({ item, actions, canRefresh, disabled, onAction, onRefresh, onDelete }: {
  item: PluginResourceView;
  actions: PluginResourceAction[];
  canRefresh: boolean;
  disabled: boolean;
  onAction: (action: PluginResourceAction) => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const { locale } = useI18n();
  return <Card className={styles.resourceRow}>
    <div className={styles.rowMain}>
      <div className={styles.rowTitleWrap}>
        <strong className={styles.rowTitle}>{item.displayName}</strong>
        {item.description && <span className={styles.rowTag}>{pluginText(item.description, locale)}</span>}
      </div>
      {item.metrics.length > 0 && <div className={styles.rowMetrics}>
        {item.metrics.map((metric) => <span key={metric.id} className={styles.metricItem}>
          <span className={styles.metricDot} />
          {metric.unit === "percent"
            ? t("{label} 剩余 {percent}%", { label: pluginText(metric.label, locale), percent: Math.round(metric.value) })
            : `${pluginText(metric.label, locale)}: ${metric.value}`}
        </span>)}
      </div>}
    </div>
    <div className={styles.actions}>
      <StateBadge state={item.state} />
      {actions.map((action) => <Button key={action.id} size="small" disabled={disabled} onClick={() => onAction(action)}>{pluginText(action.displayName, locale)}</Button>)}
      {canRefresh && <Button size="small" disabled={disabled} onClick={onRefresh}>{t("刷新")}</Button>}
      <Button size="small" className={styles.deleteButton} disabled={disabled} onClick={onDelete}>{t("删除")}</Button>
    </div>
  </Card>;
}

function ResourceActionModal({ action, cardAction, result, busy, error, onClose, onCardAction }: {
  action: PluginResourceAction | null;
  cardAction: PluginResourceAction | null;
  result: PluginResourceActionResult | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCardAction: (action: PluginResourceAction, card: PluginResourceActionCard) => void;
}) {
  const { locale } = useI18n();
  const [pendingCard, setPendingCard] = useState<PluginResourceActionCard | null>(null);
  const title = result ? pluginText(result.title, locale) : action ? pluginText(action.displayName, locale) : t("资源详情");
  const cardActions = cardAction ? [cardAction] : [];

  return <>
    <Modal compact open title={title} busy={busy} onClose={onClose} submitLabel={t("关闭")} onSubmit={onClose}>
      <div className={styles.actionBody}>
        {result?.description && <span className={styles.actionDescription}>{pluginText(result.description, locale)}</span>}
        {busy && <span className={styles.empty}>{t("正在加载…")}</span>}
        {error && <span className={styles.error} role="alert">{error}</span>}
        {!busy && !error && result && result.cards.length === 0 && <span className={styles.empty}>{t("没有可用的重置卡。")}</span>}
        {!busy && !error && result && <div className={styles.actionCardList}>
        {result.cards.map((card) => <Card key={card.id} className={styles.actionCard}>
          <div className={styles.actionCardMain}>
            <strong>{pluginText(card.title, locale)}</strong>
            {card.status && <span>{formatActionStatus(card.status, locale)}</span>}
            {card.grantedAtMs !== null && card.grantedAtMs !== undefined && <span>{t("发放时间：{time}", { time: formatActionDate(card.grantedAtMs, locale) })}</span>}
            {card.expiresAtMs !== null && card.expiresAtMs !== undefined && <span>{t("到期时间：{time}", { time: formatActionDate(card.expiresAtMs, locale) })}</span>}
            {card.fields.map((field) => <span key={field.id}>{pluginText(field.label, locale)}: {field.value}</span>)}
          </div>
          {cardActions.length > 0 && <div className={styles.actions}>
            {cardActions.map((cardActionItem) => <Button
              key={cardActionItem.id}
              size="small"
              disabled={busy || card.status !== "available"}
              onClick={() => cardActionItem.destructive ? setPendingCard(card) : onCardAction(cardActionItem, card)}
            >{pluginText(cardActionItem.displayName, locale)}</Button>)}
          </div>}
        </Card>)}
      </div>}
      </div>
    </Modal>
    {pendingCard && cardAction && <ConfirmDialog
      open
      title={t("使用重置卡")}
      busy={busy}
      confirmLabel={t("确认使用")}
      onCancel={() => setPendingCard(null)}
      onConfirm={() => {
        const card = pendingCard;
        setPendingCard(null);
        onCardAction(cardAction, card);
      }}
    >
      <p>{t("使用后会立即消耗这张重置卡，且无法恢复。确定继续吗？")}</p>
      <strong>{pluginText(pendingCard.title, locale)}</strong>
    </ConfirmDialog>}
  </>;
}

function formatActionStatus(status: PluginResourceActionCard["status"], locale: string) {
  const value = typeof status === "string" ? status : pluginText(status, locale);
  switch (value.toLowerCase()) {
    case "available": return t("可用");
    case "redeemed":
    case "used": return t("已使用");
    case "expired": return t("已过期");
    default: return value;
  }
}

function formatActionDate(value: number, locale: string) {
  return new Date(value).toLocaleString(locale);
}

function StateBadge({ state }: { state: PluginResourceView["state"] }) {
  if (state.status === "cooling") {
    return <span className={`${styles.stateBadge} ${styles.stateCooling}`} title={state.message ?? undefined}>
      <span className={styles.stateDot} />
      <span>{t("冷却中")}</span>
    </span>;
  }
  if (state.status === "invalid") {
    return <span className={`${styles.stateBadge} ${styles.stateInvalid}`} title={state.message ?? undefined}>
      <span className={styles.stateDot} />
      <span>{t("已失效")}</span>
    </span>;
  }
  return <span className={`${styles.stateBadge} ${styles.stateReady}`}>
    <span className={styles.stateDot} />
    <span>{t("可用")}</span>
  </span>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
