import { useEffect, useMemo, useRef, useState } from "react";
import cursorIconUrl from "../../shared/assets/icons/cursor.svg";
import { api, configuredPluginModels, type TabMode, type TabSettings } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { Combobox, Select, type ComboboxHandle } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./TabSettingsCard.module.scss";

export function TabSettingsCard() {
  const { models, plugins } = useAppStore();
  const message = useMessage();
  const [tabSettings, setTabSettings] = useState<TabSettings | null>(null);
  const [tabDraft, setTabDraft] = useState<TabSettings>({ mode: "direct", address: "", api_key: "", model: "" });
  const [tabModels, setTabModels] = useState<string[]>([]);
  const [discoveringTabModels, setDiscoveringTabModels] = useState(false);
  const [editingTab, setEditingTab] = useState(false);
  const [savingTab, setSavingTab] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const modelCombobox = useRef<ComboboxHandle>(null);
  const addressInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addressError) addressInput.current?.focus();
  }, [addressError]);

  const { modelOptions, modelLabels } = useMemo(() => {
    const local = tabDraft.mode === "local";
    const seen = new Set<string>();
    const options: string[] = [];
    const labels: Record<string, string> = {};
    const push = (value: string, label?: string) => {
      const name = value.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      options.push(name);
      if (label && label !== name) labels[name] = label;
    };
    if (local) {
      for (const model of models) push(model.model_id);
      for (const model of configuredPluginModels(plugins)) push(model.id, `${model.displayName} · ${model.pluginName}`);
    } else {
      for (const model of tabModels) push(model);
    }
    return { modelOptions: options, modelLabels: labels };
  }, [tabDraft.mode, tabModels, models, plugins]);

  useEffect(() => {
    const report = (cause: unknown) => message(cause instanceof Error ? cause.message : String(cause));
    void api.tabSettings().then((next) => {
      setTabSettings(next);
      setTabDraft(next);
    }).catch(report);
  }, [message]);

  const editTab = () => {
    if (!tabSettings) return;
    setTabDraft(tabSettings);
    setAddressError(null);
    setEditingTab(true);
  };
  const cancelTabEdit = () => {
    if (tabSettings) setTabDraft(tabSettings);
    setAddressError(null);
    setEditingTab(false);
  };
  const addressProblem = (value: string) => {
    if (!value) return t("TAB 服务地址不能为空");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return t("TAB 服务地址不是合法网址");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return t("TAB 服务地址需以 http:// 或 https:// 开头");
    }
    if (parsed.search || parsed.hash) return t("TAB 服务地址不能带查询串或锚点");
    return null;
  };
  const saveTab = async () => {
    const address = tabDraft.address.trim();
    if (tabDraft.mode === "custom") {
      const problem = addressProblem(address);
      if (problem) {
        setAddressError(problem);
        return;
      }
    }
    if (tabDraft.mode === "local" && !tabDraft.model.trim()) {
      message(t("请选择用于 TAB 补全的模型"));
      return;
    }
    setAddressError(null);
    try {
      setSavingTab(true);
      const saved = await api.setTabSettings({
        ...tabDraft,
        address,
        api_key: tabDraft.api_key.trim(),
        model: tabDraft.model.trim(),
      });
      setTabSettings(saved);
      setTabDraft(saved);
      setEditingTab(false);
      message(t("TAB 设置已保存"));
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (text.includes("TAB service address")) setAddressError(text);
      else if (text.includes("unknown variant")) message(t("后台服务版本较旧，请重启开发服务后再试"));
      else message(text);
    } finally {
      setSavingTab(false);
    }
  };
  const discoverTabModels = async () => {
    const address = tabDraft.address.trim();
    const problem = addressProblem(address);
    if (problem) {
      setAddressError(problem);
      return false;
    }
    try {
      setDiscoveringTabModels(true);
      const { models: discovered } = await api.discoverTabModels({ address, api_key: tabDraft.api_key.trim() });
      setTabModels(discovered);
      message(discovered.length ? t("已获取 {count} 个模型", { count: discovered.length }) : t("服务没有返回任何模型"));
      return discovered.length > 0;
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setDiscoveringTabModels(false);
    }
  };

  const handleDraftChange = (draft: TabSettings) => {
    let next = draft;
    if (next.address !== tabDraft.address) {
      setTabModels([]);
      setAddressError(null);
    }
    if (next.mode !== tabDraft.mode) {
      setAddressError(null);
      if (next.mode === "local" || tabDraft.mode === "local") next = { ...next, model: "" };
    }
    setTabDraft(next);
  };

  const modeOptions: { value: TabMode; label: string }[] = [
    { value: "direct", label: t("直连") },
    { value: "custom", label: t("自定义 TAB 服务") },
    { value: "local", label: t("使用已配置模型") },
  ];
  const modeLabel = (mode: TabMode) => (mode === "custom" ? t("自定义 TAB 服务") : mode === "local" ? t("使用已配置模型") : t("直连"));
  const discover = async () => {
    if (await discoverTabModels()) modelCombobox.current?.openAll();
  };
  const needsAddress = tabDraft.mode === "custom" && !tabDraft.address.trim();
  const action = editingTab ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={savingTab} onClick={cancelTabEdit}>{t("取消")}</Button>
      <Button variant="primary" size="small" disabled={savingTab} onClick={() => void saveTab()}>{savingTab ? t("保存中…") : t("保存")}</Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} disabled={!tabSettings} onClick={editTab}>{t("编辑")}</button>
  );

  return <TitledCard
    title={<div className={styles.title}><Icon src={cursorIconUrl} size="1.1em" /><span>{t("TAB 服务")}</span></div>}
    action={action}
  >
    <div className={styles.content}>
      {editingTab ? <>
        <div className={styles.row}>
          <div className={styles.description}>
            <strong>{t("TAB 选择")}</strong>
            <small>{t("控制 Cursor TAB 相关接口的连接方式。")}</small>
          </div>
          <div className={styles.control}><Select
            value={tabDraft.mode}
            ariaLabel={t("TAB 选择")}
            options={modeOptions}
            onChange={(mode) => handleDraftChange({ ...tabDraft, mode: mode as TabMode })}
          /></div>
        </div>
        {tabDraft.mode === "custom" && <>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("TAB 服务地址")}</strong>
              <small>{t("原接口路径会追加到此服务地址；该地址需实现 Cursor TAB 协议，普通对话接口无法替代。")}</small>
            </div>
            <div className={styles.control}>
              <TextInput
                ref={addressInput}
                value={tabDraft.address}
                placeholder="https://tab.example.com"
                aria-label={t("TAB 服务地址")}
                aria-invalid={addressError ? true : undefined}
                onChange={(event) => handleDraftChange({ ...tabDraft, address: event.target.value })}
                onKeyDown={(event) => { if (event.key === "Enter") void saveTab(); }}
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
              value={tabDraft.api_key}
              placeholder="sk-xxxxxx"
              autoComplete="off"
              aria-label={t("访问密钥")}
              onChange={(event) => handleDraftChange({ ...tabDraft, api_key: event.target.value })}
            /></div>
          </div>
        </>}
        {tabDraft.mode !== "direct" && <>
          <div className={styles.row}>
            <div className={styles.description}>
              <strong>{t("TAB 模型")}</strong>
              <small>{tabDraft.mode === "local"
                ? t("由本机已配置的模型直接生成补全（含已启用插件模型），不再经过外部 TAB 服务。")
                : t("写入 TAB 请求的模型名；点「获取模型」读取该服务支持的模型，也可直接填写。留空时沿用 Cursor 自己选择的模型。")}</small>
            </div>
            <div className={styles.control}>
              <Combobox
                ref={modelCombobox}
                value={tabDraft.model}
                options={modelOptions}
                optionLabels={modelLabels}
                placeholder={t("填写或获取模型")}
                append={tabDraft.mode === "custom" ? (
                  <Button
                    className={styles.discoverButton}
                    size="small"
                    disabled={discoveringTabModels || needsAddress}
                    onClick={() => void discover()}
                  >
                    {discoveringTabModels ? t("获取中…") : t("获取模型")}
                  </Button>
                ) : undefined}
                onChange={(model) => handleDraftChange({ ...tabDraft, model })}
              />
            </div>
          </div>
        </>}
      </> : <>
        <div className={styles.row}>
          <strong>{t("TAB 选择")}</strong>
          <span className={styles.value}>{tabSettings ? modeLabel(tabSettings.mode) : t("加载中…")}</span>
        </div>
        {tabSettings?.mode === "custom" && <div className={styles.row}>
          <strong>{t("TAB 服务地址")}</strong>
          <span className={styles.value}>{tabSettings.address}</span>
        </div>}
        {tabSettings && tabSettings.mode !== "direct" && <div className={styles.row}>
          <strong>{t("TAB 模型")}</strong>
          <span className={styles.value}>{tabSettings.model ? (modelLabels[tabSettings.model] ?? tabSettings.model) : t("沿用 Cursor 自己选择的模型")}</span>
        </div>}
        {tabSettings?.mode === "custom" && <div className={styles.row}>
          <strong>{t("访问密钥")}</strong>
          <span className={styles.value}>{tabSettings.api_key ? t("已配置") : t("未配置")}</span>
        </div>}
      </>}
    </div>
  </TitledCard>;
}
