import type { IconifyIcon } from "@iconify/react/offline";
import { useState, type ReactNode } from "react";
import type { Model } from "../../shared/api";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon, chevronRightIcon, claudeIcon, editIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";
import { resolveModelBrandIcon } from "./modelBrandIcon";
import type { ModelClient } from "./modelCopy";
import { SortableModelList } from "./SortableModelList";

export type CursorModelGrouping = "flat" | "provider" | "type";

export type CursorModelGroup = {
  key: string;
  label: string;
  icon: IconifyIcon;
  models: Model[];
};

type CursorModelCardsProps = {
  client: ModelClient;
  models: Model[];
  grouping: CursorModelGrouping;
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: Model) => void;
  onEdit: (model: Model) => void;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onReorder: (modelHashes: string[]) => void;
  onGroupSettings: (group: CursorModelGroup) => void;
};

type ModelGridProps = Omit<CursorModelCardsProps, "grouping" | "onGroupSettings">;

export function cursorModelGroups(models: Model[], grouping: Exclude<CursorModelGrouping, "flat">): CursorModelGroup[] {
  const groups = new Map<string, CursorModelGroup>();
  for (const model of models) {
    const descriptor = grouping === "provider" ? providerGroup(model) : typeGroup(model);
    const group = groups.get(descriptor.key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(descriptor.key, { ...descriptor, models: [model] });
    }
  }
  return [...groups.values()];
}

export function CursorModelCards(props: CursorModelCardsProps) {
  return props.grouping === "flat"
    ? <div style={{ paddingTop: "10px" }}><ModelGrid {...props} /></div>
    : <div className={styles.modelGroups}>
      {cursorModelGroups(props.models, props.grouping).map((group) => <CollapsibleGroup
        key={group.key}
        label={group.label}
        icon={group.icon}
        defaultOpen={false}
        onSettings={props.grouping === "provider" ? () => props.onGroupSettings(group) : undefined}
      >
        <SortableModelList client={props.client} models={group.models} disabled={props.disabled} className={styles.modelList} itemClassName={styles.modelRow}>
          {group.models.map((model) => <ModelListRow
            key={model.model_hash}
            model={model}
            disabled={props.disabled}
            testing={props.testingModelHashes.has(model.model_hash)}
            result={props.testResults.get(model.model_hash)}
            onTest={() => props.onTest(model)}
            onEdit={() => props.onEdit(model)}
            onDuplicate={() => props.onDuplicate(model)}
            onDelete={() => props.onDelete(model)}
          />)}
        </SortableModelList>
      </CollapsibleGroup>)}
    </div>;
}

function CollapsibleGroup({ label, icon, defaultOpen = true, onSettings, children }: {
  label: string;
  icon?: IconifyIcon;
  defaultOpen?: boolean;
  onSettings?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <Card className={styles.groupCard}>
    <div className={styles.groupHeader}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {icon && <Icon icon={icon} size="1.1em" />}
        <span className={styles.groupLabel}>{label}</span>
      </button>
      {onSettings && <button type="button" className={styles.groupSettings} onClick={onSettings}>
        <Icon icon={editIcon} size="1em" />
        {t("分组设置")}
      </button>}
      <button
        type="button"
        className={styles.groupChevron}
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon icon={open ? chevronDownIcon : chevronRightIcon} size="1em" />
      </button>
    </div>
    {open && children}
  </Card>;
}

function ModelListRow({
  model,
  disabled,
  testing,
  result,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  model: Model;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const brand = resolveModelBrandIcon(model);
  return <div className={styles.modelRow} data-model-hash={model.model_hash} data-model-draggable={!disabled || undefined}>
    <div className={styles.modelRowLeft}>
      <div className={styles.modelAvatarSmall} aria-hidden="true">
        {brand.src ? <img src={brand.src} alt="" /> : <Icon icon={brand.icon} size={brand.name === "OpenAI" ? "1.4em" : "1.15em"} />}
      </div>
      <div className={styles.modelRowName}>
        <span className={styles.modelRowNameText}>{model.display_name}</span>
        <span className={styles.modelRowModelId}>{model.model_id}</span>
      </div>
    </div>
    <CursorModelTestResult compact state={result} note={model.tooltip_data} testing={testing} />
    <div className={styles.modelCardActions}>
      <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={onTest} />
      <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={onEdit} />
      <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={onDuplicate} />
      <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={onDelete} />
    </div>
  </div>;
}

function ModelGrid({
  client,
  models,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
  onReorder,
}: ModelGridProps) {
  return <SortableModelList client={client} models={models} disabled={disabled} className={styles.modelGrid} itemClassName={styles.modelCard} onReorder={onReorder}>
    {models.map((model) => {
      const result = testResults.get(model.model_hash);
      const testing = testingModelHashes.has(model.model_hash);
      const brand = resolveModelBrandIcon(model);
      return <Card className={styles.modelCard} data-model-hash={model.model_hash} data-model-draggable={!disabled || undefined} key={model.model_hash}>
        <div className={styles.modelCardContent}>
          <div className={styles.modelCardTop}>
            <div className={styles.modelCardTitleGroup}>
              <div className={styles.modelAvatar} aria-hidden="true">
                {brand.src ? (
                  <img src={brand.src} alt="" />
                ) : (
                  <Icon icon={brand.icon} size={brand.name === "OpenAI" ? "2em" : "1.35em"} />
                )}
              </div>
              <div className={styles.modelCardName}>
                <span className={styles.modelCardNameText}>{model.display_name}</span>
                <span className={styles.modelCardModelId}>{model.model_id}</span>
              </div>
            </div>
            <span className={styles.modelTypeBadge}>
              {model.type === "anthropic" ? "Anthropic" : "OpenAI"}
            </span>
          </div>
          <div className={styles.modelCardTest}>
            <CursorModelTestResult state={result} note={model.tooltip_data} testing={testing} />
          </div>
          <div className={styles.modelCardActions}>
            <TruncatedButton size="small" disabled={disabled && !testing} label={testing ? t("取消测试") : t("测试")} onClick={() => onTest(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("编辑")} onClick={() => onEdit(model)} />
            <TruncatedButton size="small" disabled={disabled} label={t("复制")} onClick={() => onDuplicate(model)} />
            <TruncatedButton size="small" className={styles.deleteButton} disabled={disabled} label={t("删除")} onClick={() => onDelete(model)} />
          </div>
        </div>
      </Card>;
    })}
  </SortableModelList>;
}

function providerGroup(model: Model) {
  const key = providerDomain(model.base_url);
  const label = model.group_name?.trim() || key;
  return { key, label, icon: flatColorOrganizationIcon };
}

function providerDomain(baseUrl: string) {
  const value = baseUrl.trim();
  try {
    return new URL(value).hostname.toLowerCase() || value;
  } catch {
    try {
      return new URL(`https://${value}`).hostname.toLowerCase() || value;
    } catch {
      return value;
    }
  }
}

function typeGroup(model: Model) {
  if (model.type === "anthropic") return { key: "anthropic", label: "Anthropic", icon: claudeIcon };
  if (model.openai_endpoint === "/v1/chat/completions") return { key: "openai-chat", label: "OpenAI Chat", icon: openAiIcon };
  return { key: "openai-responses", label: "OpenAI Responses", icon: openAiIcon };
}
