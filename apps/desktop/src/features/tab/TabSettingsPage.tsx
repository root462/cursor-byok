import { useEffect, useMemo, useState } from "react";
import { api, configuredPluginModels, type TabSettings } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { useAppStore } from "../../shared/store/appStore";
import { useMessage } from "../../shared/ui/message";
import { TabSettingsCard } from "./TabSettingsCard";
import styles from "./TabSettingsPage.module.scss";

export function TabSettingsPage() {
  const { models, plugins } = useAppStore();
  const message = useMessage();
  const [tabSettings, setTabSettings] = useState<TabSettings | null>(null);
  const [tabDraft, setTabDraft] = useState<TabSettings>({ mode: "direct", address: "", api_key: "", model: "" });
  const [tabModels, setTabModels] = useState<string[]>([]);
  const [discoveringTabModels, setDiscoveringTabModels] = useState(false);
  const [editingTab, setEditingTab] = useState(false);
  const [savingTab, setSavingTab] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  // 候选来源按模式区分，互不混淆：
  // - 本地生成：本机已配置模型 + 已启用插件模型（plugin: 复合 ID）；
  // - 自定义服务：只列「获取模型」从该地址取回的结果，本机候选一律不混入，
  //   避免把本地模型名误当成该服务支持的模型。
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
      // 服务端的地址校验错误落回输入框，其余（密钥、网络）仍用顶部提示。
      if (text.includes("TAB service address")) setAddressError(text);
      // 后端未重启时会把新模式当成非法枚举值，原样抛出 serde 文案难以理解。
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
      const { models } = await api.discoverTabModels({ address, api_key: tabDraft.api_key.trim() });
      setTabModels(models);
      message(models.length ? t("已获取 {count} 个模型", { count: models.length }) : t("服务没有返回任何模型"));
      return models.length > 0;
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setDiscoveringTabModels(false);
    }
  };

  const content = (
    <div className={styles.page}>
      <TabSettingsCard
        settings={tabSettings}
        draft={tabDraft}
        editing={editingTab}
        saving={savingTab}
        models={modelOptions}
        modelLabels={modelLabels}
        discovering={discoveringTabModels}
        addressError={addressError}
        onDraftChange={(draft) => {
          let next = draft;
          if (next.address !== tabDraft.address) {
            setTabModels([]);
            setAddressError(null);
          }
          if (next.mode !== tabDraft.mode) {
            setAddressError(null);
            // 本地模式存 plugin: 复合 ID，自定义模式存上游模型名，同名不同义，切换即清空。
            if (next.mode === "local" || tabDraft.mode === "local") next = { ...next, model: "" };
          }
          setTabDraft(next);
        }}
        onDiscover={discoverTabModels}
        onEdit={editTab}
        onCancel={cancelTabEdit}
        onSave={() => void saveTab()}
      />
    </div>
  );
  return <PageContent title={t("TAB 配置")} sections={[{ key: "tab", estimatedHeight: 320, content }]} />;
}
