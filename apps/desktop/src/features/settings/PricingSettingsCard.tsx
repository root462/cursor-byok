import { useEffect, useMemo, useState } from "react";
import {
  api,
  configuredPluginModels,
  type Model,
  type ModelPricing,
  type TokenPricingSettings,
} from "../../shared/api";
import { appStore, DEFAULT_TOKEN_PRICING, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { ModelSelect, type ModelSelectOption } from "../../shared/ui/ModelSelect";
import { Select } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { modelProviderName } from "../../shared/utils/modelProvider";
import {
  defaultModelPricing,
  effectiveModelPricing,
  globalDefaultPricing,
  isModelCustomized,
  pricingKey,
  type PricingScope,
} from "../../shared/utils/pricing";
import styles from "./PricingSettingsCard.module.scss";

const GLOBAL_DEFAULT_KEY = "__global_default__";

/** 可独立定价的客户端；同一套连接参数在各客户端下分别定价。 */
const SCOPES: Array<{ value: PricingScope; label: string }> = [
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex Desktop" },
  { value: "claude", label: "Claude CLI" },
];

/** 可单独定价的模型配置目标；`key` 是实际写入定价设置的存储键。 */
type PricingTarget = {
  key: string;
  scope: PricingScope;
  hash: string;
  modelId: string;
  name: string;
  group: string;
  icon?: typeof claudeIcon;
  iconSrc?: string;
};

type PricingDraft = {
  input_per_million: string;
  output_per_million: string;
  cache_read_per_million: string;
  cache_write_per_million: string;
};

function toDraft(pricing: ModelPricing): PricingDraft {
  return {
    input_per_million: String(pricing.input_per_million),
    output_per_million: String(pricing.output_per_million),
    cache_read_per_million: String(pricing.cache_read_per_million),
    cache_write_per_million: String(pricing.cache_write_per_million),
  };
}

function formatPrice(value: number) {
  return `$${value}`;
}

function parsePrice(value: string, label: string) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(t("{label}必须是非负数", { label }));
  }
  return price;
}

function draftToPricing(draft: PricingDraft): ModelPricing {
  return {
    input_per_million: parsePrice(draft.input_per_million, t("输入价格")),
    output_per_million: parsePrice(draft.output_per_million, t("输出价格")),
    cache_read_per_million: parsePrice(draft.cache_read_per_million, t("缓存读取价格")),
    cache_write_per_million: parsePrice(draft.cache_write_per_million, t("缓存写入价格")),
  };
}

function clientTargets(
  scope: PricingScope,
  models: Model[],
  group: string,
): PricingTarget[] {
  return models.map((model) => ({
    key: pricingKey(scope, model.model_hash),
    scope,
    hash: model.model_hash,
    modelId: model.model_id,
    name: model.display_name || model.model_id,
    group,
    icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
  }));
}

export function PricingSettingsCard() {
  const { pricing, models, plugins } = useAppStore();
  const message = useMessage();
  const [scope, setScope] = useState<PricingScope>("cursor");
  const [selectedKey, setSelectedKey] = useState<string>(GLOBAL_DEFAULT_KEY);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [codexModels, setCodexModels] = useState<Model[]>([]);
  const [claudeModels, setClaudeModels] = useState<Model[]>([]);

  useEffect(() => {
    let cancelled = false;
    const report = (cause: unknown) =>
      message(cause instanceof Error ? cause.message : String(cause));
    void api.clientModels("codex").then((list) => {
      if (!cancelled) setCodexModels(list);
    }).catch(report);
    void api.clientModels("claude").then((list) => {
      if (!cancelled) setClaudeModels(list);
    }).catch(report);
    return () => {
      cancelled = true;
    };
  }, [message]);

  const pluginModels = useMemo(() => configuredPluginModels(plugins), [plugins]);

  const scopedTargets = useMemo<Record<PricingScope, PricingTarget[]>>(() => ({
    cursor: [
      ...models.map((model) => ({
        key: pricingKey("cursor", model.model_hash),
        scope: "cursor" as const,
        hash: model.model_hash,
        modelId: model.model_id,
        name: model.display_name || model.model_id,
        group: modelProviderName(model),
        icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
      })),
      ...pluginModels.map((pm) => ({
        key: pricingKey("cursor", pm.id),
        scope: "cursor" as const,
        hash: pm.id,
        modelId: pm.modelId,
        name: pm.displayName || pm.modelId,
        group: pm.pluginName || t("插件模型"),
        iconSrc: pm.icon,
      })),
    ],
    codex: clientTargets("codex", codexModels, "Codex Desktop"),
    claude: clientTargets("claude", claudeModels, "Claude CLI"),
  }), [models, pluginModels, codexModels, claudeModels]);

  const targets = scopedTargets[scope];

  const selectedTarget = useMemo(
    () => (selectedKey === GLOBAL_DEFAULT_KEY ? null : targets.find((item) => item.key === selectedKey) ?? null),
    [targets, selectedKey],
  );

  const currentPricing = useMemo(() => {
    if (!selectedTarget) {
      return globalDefaultPricing(pricing);
    }
    return effectiveModelPricing(pricing, selectedTarget.scope, selectedTarget.hash, selectedTarget.modelId);
  }, [pricing, selectedTarget]);

  const [draft, setDraft] = useState<PricingDraft>(() => toDraft(currentPricing));

  useEffect(() => {
    if (!editing) {
      setDraft(toDraft(currentPricing));
    }
  }, [currentPricing, editing]);

  const modelOptions = useMemo(() => {
    const options: ModelSelectOption[] = [
      {
        value: GLOBAL_DEFAULT_KEY,
        label: t("全局默认定价"),
        group: t("通用默认"),
      },
    ];
    for (const target of targets) {
      const customized = isModelCustomized(pricing, target.scope, target.hash);
      const hasDefault = defaultModelPricing(target.modelId) !== null;
      const statusSuffix = customized
        ? ` (${t("已自定义")})`
        : hasDefault
        ? ` (${t("默认推荐")})`
        : "";
      options.push({
        value: target.key,
        label: `${target.name}${statusSuffix}`,
        group: target.group,
        icon: target.icon,
        iconSrc: target.iconSrc,
      });
    }
    return options;
  }, [targets, pricing]);

  const changeScope = (next: PricingScope) => {
    setScope(next);
    // 同一套连接参数常被多个客户端复用，切换时保留同名模型，便于分别定价。
    const sameHash = selectedTarget && scopedTargets[next].find((item) => item.hash === selectedTarget.hash);
    const nextKey = sameHash?.key ?? GLOBAL_DEFAULT_KEY;
    setSelectedKey(nextKey);
    if (editing) {
      setDraft(toDraft(sameHash
        ? effectiveModelPricing(pricing, sameHash.scope, sameHash.hash, sameHash.modelId)
        : globalDefaultPricing(pricing)));
    }
  };

  const handleModelChange = (value: string) => {
    setSelectedKey(value);
    const target = targets.find((item) => item.key === value);
    setDraft(toDraft(target
      ? effectiveModelPricing(pricing, target.scope, target.hash, target.modelId)
      : globalDefaultPricing(pricing)));
  };

  const isCustom = selectedTarget
    ? isModelCustomized(pricing, selectedTarget.scope, selectedTarget.hash)
    : false;
  const hasBuiltinDefault = selectedTarget
    ? defaultModelPricing(selectedTarget.modelId) !== null
    : false;

  const badgeTone = !selectedTarget
    ? "primary"
    : isCustom
    ? "ok"
    : "muted";
  const badgeLabel = !selectedTarget
    ? t("全局兜底")
    : isCustom
    ? t("已自定义定价")
    : hasBuiltinDefault
    ? t("系统推荐默认")
    : t("使用全局默认");

  const edit = () => {
    setDraft(toDraft(currentPricing));
    setEditing(true);
  };

  const cancel = () => {
    setDraft(toDraft(currentPricing));
    setEditing(false);
  };

  const restoreDefault = () => {
    if (!selectedTarget) {
      setDraft(toDraft(DEFAULT_TOKEN_PRICING));
      return;
    }
    const builtin = defaultModelPricing(selectedTarget.modelId);
    if (builtin) {
      setDraft(toDraft(builtin));
    } else {
      setDraft(toDraft(globalDefaultPricing(pricing)));
    }
  };

  const save = async () => {
    try {
      setSaving(true);
      const parsed = draftToPricing(draft);
      let nextSettings: TokenPricingSettings;

      if (!selectedTarget) {
        nextSettings = {
          ...pricing,
          input_per_million: parsed.input_per_million,
          output_per_million: parsed.output_per_million,
          cache_read_per_million: parsed.cache_read_per_million,
          cache_write_per_million: parsed.cache_write_per_million,
        };
      } else {
        const nextModels = { ...(pricing.models ?? {}) };
        nextModels[selectedTarget.key] = parsed;
        nextSettings = {
          ...pricing,
          models: nextModels,
        };
      }

      if (await appStore.updatePricingSettings(nextSettings)) {
        setEditing(false);
        message(t("定价设置已保存"));
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={restoreDefault}>
        {t("恢复默认")}
      </Button>
      <Button size="small" disabled={saving} onClick={cancel}>
        {t("取消")}
      </Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>
        {saving ? t("保存中…") : t("保存")}
      </Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} onClick={edit}>
      {t("编辑")}
    </button>
  );

  return (
    <TitledCard title={t("Token 定价")} action={action}>
      <div className={styles.content}>
        <small className={styles.description}>
          {t("用于首页驾驶舱价值估算的 Token 单价。Cursor、Codex Desktop 与 Claude CLI 分别独立定价，即使它们共用同一个 API 地址和 Key。单位：美元 / 百万 Token。")}
        </small>

        <div className={styles.selectorRow}>
          <strong>{t("配置目标")}</strong>
          <div className={styles.modelPicker}>
            <Select
              ariaLabel={t("配置目标")}
              value={scope}
              options={SCOPES}
              onChange={(value) => changeScope(value as PricingScope)}
              disabled={saving}
            />
            <ModelSelect
              mode="single"
              label={t("选择模型")}
              options={modelOptions}
              value={selectedKey}
              onChange={handleModelChange}
              disabled={saving}
            />
            <span className={styles.badge} data-tone={badgeTone}>
              {badgeLabel}
            </span>
          </div>
        </div>

        {editing ? (
          <div className={styles.customFields}>
            <FormField label={t("输入价格（$/1M）")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.input_per_million}
                onChange={(event) => setDraft({ ...draft, input_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={t("输出价格（$/1M）")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.output_per_million}
                onChange={(event) => setDraft({ ...draft, output_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={t("缓存读取价格（$/1M）")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_read_per_million}
                onChange={(event) =>
                  setDraft({ ...draft, cache_read_per_million: event.target.value })
                }
              />
            </FormField>
            <FormField label={t("缓存写入价格（$/1M）")}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_write_per_million}
                onChange={(event) =>
                  setDraft({ ...draft, cache_write_per_million: event.target.value })
                }
              />
            </FormField>
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <strong>{t("输入价格（$/1M）")}</strong>
              <span className={styles.value}>{formatPrice(currentPricing.input_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{t("输出价格（$/1M）")}</strong>
              <span className={styles.value}>{formatPrice(currentPricing.output_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{t("缓存读取价格（$/1M）")}</strong>
              <span className={styles.value}>
                {formatPrice(currentPricing.cache_read_per_million)}
              </span>
            </div>
            <div className={styles.row}>
              <strong>{t("缓存写入价格（$/1M）")}</strong>
              <span className={styles.value}>
                {formatPrice(currentPricing.cache_write_per_million)}
              </span>
            </div>
          </>
        )}
      </div>
    </TitledCard>
  );
}