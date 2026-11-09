import { useEffect, useRef } from "react";
import cursorIconUrl from "../../shared/assets/icons/cursor.svg";
import type { TabMode, TabSettings } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { Combobox, Select, type ComboboxHandle } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./TabSettingsCard.module.scss";

export function TabSettingsCard({
  settings,
  draft,
  editing,
  saving,
  models,
  modelLabels,
  discovering,
  addressError,
  onDraftChange,
  onDiscover,
  onEdit,
  onCancel,
  onSave,
}: {
  settings: TabSettings | null;
  draft: TabSettings;
  editing: boolean;
  saving: boolean;
  models: string[];
  modelLabels?: Record<string, string>;
  discovering: boolean;
  addressError?: string | null;
  onDraftChange: (settings: TabSettings) => void;
  onDiscover: () => Promise<boolean>;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const modelCombobox = useRef<ComboboxHandle>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (addressError) addressInput.current?.focus();
  }, [addressError]);
  const modeOptions: { value: TabMode; label: string }[] = [
    { value: "direct", label: t("直连") },
    { value: "custom", label: t("自定义 TAB 服务") },
    { value: "local", label: t("使用已配置模型") },
  ];
  const modeLabel = (mode: TabMode) => (mode === "custom" ? t("自定义 TAB 服务") : mode === "local" ? t("使用已配置模型") : t("直连"));
  const discover = async () => {
    if (await onDiscover()) modelCombobox.current?.openAll();
  };
  const needsAddress = draft.mode === "custom" && !draft.address.trim();
  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={onCancel}>{t("取消")}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={onSave}>{saving ? t("保存中…") : t("保存")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} disabled={!settings} onClick={onEdit}>{t("编辑")}</button>
  );

  return <TitledCard
    title={<div className={styles.title}><Icon src={cursorIconUrl} size="1.1em" /><span>{t("TAB 服务")}</span></div>}
    action={action}
  >
    <div className={styles.content}>
      {editing ? <>
        <div className={styles.row}>
          <div className={styles.description}>
            <strong>{t("TAB 选择")}</strong>
            <small>{t("控制 Cursor TAB 相关接口的连接方式。")}</small>
          </div>
          <div className={styles.control}><Select
            value={draft.mode}
            ariaLabel={t("TAB 选择")}
            options={modeOptions}
            onChange={(mode) => onDraftChange({ ...draft, mode: mode as TabMode })}
          /></div>
        </div>
        {draft.mode === "custom" && <>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("TAB 服务地址")}</strong>
              <small>{t("原接口路径会追加到此服务地址；该地址需实现 Cursor TAB 协议，普通对话接口无法替代。")}</small>
            </div>
            <div className={styles.control}>
              <TextInput
                ref={addressInput}
                value={draft.address}
                placeholder="https://tab.example.com"
                aria-label={t("TAB 服务地址")}
                aria-invalid={addressError ? true : undefined}
                onChange={(event) => onDraftChange({ ...draft, address: event.target.value })}
                onKeyDown={(event) => { if (event.key === "Enter") onSave(); }}
              />
              {addressError && <small className={styles.fieldError} role="alert">{addressError}</small>}
            </div>
          </div>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("访问密钥")}</strong>
              <small>{t("以 Bearer 方式随 TAB 请求发送，留空则不携带密钥。")}</small>
            </div>
            <div className={styles.control}><SecretTextInput
              value={draft.api_key}
              placeholder="sk-xxxxxx"
              autoComplete="off"
              aria-label={t("访问密钥")}
              onChange={(event) => onDraftChange({ ...draft, api_key: event.target.value })}
            /></div>
          </div>
        </>}
        {draft.mode !== "direct" && <>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("TAB 模型")}</strong>
              <small>{draft.mode === "local"
                ? t("由本机已配置的模型直接生成补全（含已启用插件模型），不再经过外部 TAB 服务。")
                : t("写入 TAB 请求的模型名；点「获取模型」读取该服务支持的模型，也可直接填写。留空时沿用 Cursor 自己选择的模型。")}</small>
            </div>
            <div className={styles.modelControl}><Combobox
              ref={modelCombobox}
              value={draft.model}
              options={models}
              optionLabels={modelLabels}
              placeholder={t("填写或获取模型")}
              append={draft.mode === "custom" ? <Button className={styles.discoverButton} size="small" disabled={discovering || needsAddress} onClick={() => void discover()}>{discovering ? t("获取中…") : t("获取模型")}</Button> : undefined}
              onChange={(model) => onDraftChange({ ...draft, model })}
            />
            {draft.mode === "custom" && models.length === 0 && <small className={styles.fieldHint}>{t("填写服务地址后点「获取模型」，读取该服务支持的模型；也可直接填写模型名。")}</small>}
            </div>
          </div>
        </>}
      </> : <>
        <div className={styles.row}>
          <strong>{t("TAB 选择")}</strong>
          <span className={styles.value}>{settings ? modeLabel(settings.mode) : t("加载中…")}</span>
        </div>
        {settings?.mode === "custom" && <div className={styles.row}>
          <strong>{t("TAB 服务地址")}</strong>
          <span className={styles.value}>{settings.address}</span>
        </div>}
        {settings && settings.mode !== "direct" && <div className={styles.row}>
          <strong>{t("TAB 模型")}</strong>
          <span className={styles.value}>{settings.model ? (modelLabels?.[settings.model] ?? settings.model) : t("沿用 Cursor 自己选择的模型")}</span>
        </div>}
        {settings?.mode === "custom" && <div className={styles.row}>
          <strong>{t("访问密钥")}</strong>
          <span className={styles.value}>{settings.api_key ? t("已配置") : t("未配置")}</span>
        </div>}
      </>}
    </div>
  </TitledCard>;
}
