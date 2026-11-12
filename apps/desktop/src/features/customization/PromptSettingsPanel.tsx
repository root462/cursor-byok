import { useCallback, useEffect, useState } from "react";
import { api, type CustomizationClient, type PromptSettings, type PromptTemplate } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextArea, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { checkCircleIcon, warningIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import styles from "./PromptSettingsPanel.module.scss";

type PromptDraft = { id: string | null; name: string; content: string; enabled: boolean };

const CLIENT_NAMES: Record<CustomizationClient, string> = {
  claude: "Claude CLI",
  codex: "Codex Desktop",
};

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString();
}

/** 列表里只给相对时间，精确时间留在 title；超过一周直接显示日期。 */
function relativeTime(ms: number) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return t("刚刚");
  if (minutes < 60) return t("{count} 分钟前", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{count} 小时前", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("{count} 天前", { count: days });
  return new Date(ms).toLocaleDateString();
}

export function PromptSettingsPanel({ client }: { client: CustomizationClient }) {
  const message = useMessage();
  const [settings, setSettings] = useState<PromptSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);

  const clientName = CLIENT_NAMES[client];
  const fileName = client === "claude" ? "CLAUDE.md" : "AGENTS.md";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await api.promptSettings(client));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [client, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<PromptSettings>, success?: string) => {
    try {
      setSettings(await action());
      if (success) message(success);
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      message(t("提示词名称不能为空"));
      return;
    }
    setSaving(true);
    try {
      setSettings(await api.savePrompt(client, {
        id: draft.id,
        name: draft.name.trim(),
        content: draft.content,
        enabled: draft.enabled,
      }));
      setDraft(null);
      message(t("提示词已保存"));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const enabled = settings?.prompts.find((prompt) => prompt.enabled) ?? null;
  const fileMatchesEnabled = enabled !== null && settings?.file_content === enabled.content;
  // 目标文件三种状态：缺失、与启用模板一致、被外部改过；都没启用时只是中性提示。
  const fileState = settings?.file_content == null
    ? { tone: "warn", text: t("文件不存在"), icon: warningIcon }
    : enabled
      ? fileMatchesEnabled
        ? { tone: "ok", text: t("与「{name}」一致", { name: enabled.name }), icon: checkCircleIcon }
        : { tone: "warn", text: t("文件内容被外部修改"), icon: warningIcon }
      : { tone: "idle", text: t("未启用任何提示词"), icon: null };

  return <>
    <div className={styles.panel}>
      <div className={styles.summary}>
        <div className={styles.fileLine}>
          <code title={settings?.display_path}>{settings?.display_path ?? "…"}</code>
          <span className={styles.fileState} data-tone={fileState.tone}>
            {fileState.icon && <Icon icon={fileState.icon} size="1em" />}
            {fileState.text}
          </span>
        </div>
        <small>{t("启用的提示词会写入 {file}，{name} 每次启动时读取该文件作为全局指令。", { file: fileName, name: clientName })}</small>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.count}>
          {settings ? t("{count} 条提示词", { count: settings.prompts.length }) : ""}
        </span>
        <Button variant="primary" size="small" disabled={loading} onClick={() => setDraft({ id: null, name: "", content: "", enabled: false })}>
          {t("新建提示词")}
        </Button>
      </div>

      {settings && settings.prompts.length === 0 ? (
        <div className={styles.gate}>
          <strong>{t("还没有提示词模板")}</strong>
          <span>{t("新建一条模板，启用后立即写入 {file}。", { file: fileName })}</span>
        </div>
      ) : (
        // 弹窗比单列列表宽得多，卡片按列铺开才能让每条模板各有完整的操作区。
        <ul className={styles.list}>
          {settings?.prompts.map((prompt) => (
            <li className={styles.row} key={prompt.id} data-enabled={prompt.enabled || undefined}>
              <div className={styles.header}>
                <strong title={prompt.name}>{prompt.name}</strong>
                {prompt.enabled && <span className={styles.badge}>
                  <Icon icon={checkCircleIcon} size="1em" />
                  {t("已启用")}
                </span>}
              </div>
              <span className={styles.meta}>
                {t("{count} 字", { count: prompt.content.length })}
                <span className={styles.separator} aria-hidden="true">·</span>
                <time dateTime={new Date(prompt.updated_at_ms).toISOString()} title={formatTime(prompt.updated_at_ms)}>
                  {relativeTime(prompt.updated_at_ms)}
                </time>
              </span>
              {prompt.content.trim()
                ? <p className={styles.preview}>{prompt.content.trim()}</p>
                : <p className={`${styles.preview} ${styles.emptyPreview}`}>{t("还没有内容")}</p>}
              <div className={styles.actions}>
                <TooltipTrigger label={prompt.enabled ? t("关闭后清空目标文件") : t("启用这条提示词")}>
                  <Switch
                    checked={prompt.enabled}
                    disabled={loading}
                    label={prompt.enabled ? t("已启用") : t("启用")}
                    onChange={(checked) => void run(
                      () => api.setPromptEnabled(client, prompt.id, checked),
                      checked
                        ? t("已启用「{name}」", { name: prompt.name })
                        : t("已停用「{name}」", { name: prompt.name }),
                    )}
                  />
                </TooltipTrigger>
                <span className={styles.actionsSpacer} />
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => setDraft({ id: prompt.id, name: prompt.name, content: prompt.content, enabled: prompt.enabled })}
                >
                  {t("编辑")}
                </Button>
                {prompt.enabled ? (
                  // 禁用态的按钮不派发指针事件，提示要挂在包一层的元素上才出得来。
                  <TooltipTrigger label={t("启用中的提示词不能删除")}>
                    <span className={styles.disabledAnchor}>
                      <Button variant="secondary" size="small" disabled>{t("删除")}</Button>
                    </span>
                  </TooltipTrigger>
                ) : (
                  <Button
                    variant="secondary"
                    size="small"
                    className={styles.dangerButton}
                    onClick={() => setDeleting(prompt)}
                  >
                    {t("删除")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>

    <Modal
      open={draft !== null}
      wide
      fullHeight
      busy={saving}
      title={draft?.id ? t("编辑提示词") : t("新建提示词")}
      onClose={() => setDraft(null)}
      onSubmit={() => void save()}
      submitLabel={t("保存")}
    >
      {draft && <div className={styles.editor}>
        <FormField label={t("名称")}>
          <TextInput
            value={draft.name}
            placeholder={t("例如：默认工作约定")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </FormField>
        <div className={styles.editorBody}>
          <label className={styles.contentLabel}>
            <div className={styles.contentLabelRow}>
              <span>{t("内容")}</span>
              <small>{t("写入 {file} 的完整 Markdown 内容。", { file: fileName })}</small>
            </div>
            <TextArea
              value={draft.content}
              placeholder={t("在这里写下要始终生效的指令…")}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            />
          </label>
        </div>
        <div className={styles.enableRow}>
          <Switch
            checked={draft.enabled}
            label={t("保存后立即启用")}
            onChange={(checked) => setDraft({ ...draft, enabled: checked })}
          />
          <small>{t("启用后写入目标文件；同一时间只有一条提示词生效。")}</small>
        </div>
      </div>}
    </Modal>

    <ConfirmDialog
      open={deleting !== null}
      title={t("删除提示词")}
      cancelLabel={t("取消")}
      confirmLabel={t("删除")}
      onCancel={() => setDeleting(null)}
      onConfirm={() => {
        const target = deleting;
        setDeleting(null);
        if (target) void run(() => api.deletePrompt(client, target.id), t("已删除「{name}」", { name: target.name }));
      }}
    >
      <p>{t("确定删除「{name}」吗？目标文件不受影响。", { name: deleting?.name ?? "" })}</p>
    </ConfirmDialog>
  </>;
}