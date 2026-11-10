import { useEffect, useMemo, useState } from "react";
import { configuredPluginModels, type ModelPricing, type TokenPricingSettings } from "../../shared/api";
import { appStore, DEFAULT_TOKEN_PRICING, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { ModelSelect, type ModelSelectOption } from "../../shared/ui/ModelSelect";
import { TitledCard } from "../../shared/ui/TitledCard";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { modelProviderName } from "../../shared/utils/modelProvider";
import {
  defaultModelPricing,
  effectiveModelPricing,
  globalDefaultPricing,
  isModelCustomized,
} from "../../shared/utils/pricing";
import styles from "./PricingSettingsCard.module.scss";

const GLOBAL_DEFAULT_KEY = "__global_default__";

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

export function PricingSettingsCard() {
  const { pricing, models, plugins } = useAppStore();
  const message = useMessage();
  const [selectedKey, setSelectedKey] = useState<string>(GLOBAL_DEFAULT_KEY);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const pluginModels = useMemo(() => configuredPluginModels(plugins), [plugins]);

  const selectedModel = useMemo(() => {
    if (selectedKey === GLOBAL_DEFAULT_KEY) return null;
    const m = models.find((item) => item.model_hash === selectedKey);
    if (m) {
      return { hash: m.model_hash, id: m.model_id, name: m.display_name || m.model_id };
    }
    const pm = pluginModels.find((item) => item.id === selectedKey);
    if (pm) {
      return { hash: pm.id, id: pm.modelId, name: pm.displayName || pm.modelId };
    }
    return null;
  }, [models, pluginModels, selectedKey]);

  const currentPricing = useMemo(() => {
    if (!selectedModel) {
      return globalDefaultPricing(pricing);
    }
    return effectiveModelPricing(pricing, selectedModel.hash, selectedModel.id);
  }, [pricing, selectedModel]);

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
    for (const model of models) {
      const customized = isModelCustomized(pricing, model.model_hash, model.model_id);
      const hasDefault = defaultModelPricing(model.model_id) !== null;
      const statusSuffix = customized
        ? ` (${t("已自定义")})`
        : hasDefault
        ? ` (${t("默认推荐")})`
        : "";
      options.push({
        value: model.model_hash,
        label: `${model.display_name || model.model_id}${statusSuffix}`,
        group: modelProviderName(model),
        icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
      });
    }
    for (const pm of pluginModels) {
      const customized = isModelCustomized(pricing, pm.id, pm.modelId);
      const hasDefault = defaultModelPricing(pm.modelId) !== null;
      const statusSuffix = customized
        ? ` (${t("已自定义")})`
        : hasDefault
        ? ` (${t("默认推荐")})`
        : "";
      options.push({
        value: pm.id,
        label: `${pm.displayName || pm.modelId}${statusSuffix}`,
        group: pm.pluginName || t("插件模型"),
        iconSrc: pm.icon,
      });
    }
    return options;
  }, [models, pluginModels, pricing]);

  const handleModelChange = (value: string) => {
    setSelectedKey(value);
    if (!editing) {
      const m = models.find((item) => item.model_hash === value);
      const pm = !m ? pluginModels.find((item) => item.id === value) : null;
      const nextPricing = m
        ? effectiveModelPricing(pricing, m.model_hash, m.model_id)
        : pm
        ? effectiveModelPricing(pricing, pm.id, pm.modelId)
        : globalDefaultPricing(pricing);
      setDraft(toDraft(nextPricing));
    }
  };

  const isCustom = selectedModel
    ? isModelCustomized(pricing, selectedModel.hash, selectedModel.id)
    : false;
  const hasBuiltinDefault = selectedModel
    ? defaultModelPricing(selectedModel.id) !== null
    : false;

  const badgeTone = !selectedModel
    ? "primary"
    : isCustom
    ? "ok"
    : "muted";
  const badgeLabel = !selectedModel
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
    if (!selectedModel) {
      setDraft(toDraft(DEFAULT_TOKEN_PRICING));
      return;
    }
    const builtin = defaultModelPricing(selectedModel.id);
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

      if (!selectedModel) {
        nextSettings = {
          ...pricing,
          input_per_million: parsed.input_per_million,
          output_per_million: parsed.output_per_million,
          cache_read_per_million: parsed.cache_read_per_million,
          cache_write_per_million: parsed.cache_write_per_million,
        };
      } else {
        const nextModels = { ...(pricing.models ?? {}) };
        nextModels[selectedModel.hash] = parsed;
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
          {t("用于首页驾驶舱价值估算的 Token 单价，可为每个模型单独设置，未设置时自动采用推荐或全局默认定价。单位：美元 / 百万 Token。")}
        </small>

        <div className={styles.selectorRow}>
          <strong>{t("配置目标")}</strong>
          <div className={styles.modelPicker}>
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
