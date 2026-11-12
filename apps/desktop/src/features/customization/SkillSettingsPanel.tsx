import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CustomizationClient,
  type InstalledSkill,
  type SkillClientPaths,
  type SkillSettings,
} from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextArea, TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { folderOpenIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import styles from "./SkillSettingsPanel.module.scss";

const CLIENT_NAMES: Record<CustomizationClient, string> = {
  claude: "Claude CLI",
  codex: "Codex Desktop",
};

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isEnabled(skill: InstalledSkill, client: CustomizationClient) {
  return client === "claude" ? skill.enabled_claude : skill.enabled_codex;
}

/** 单个客户端的 Skill 面板：列出所有 Skill，只切换当前客户端的开关。 */
export function SkillSettingsPanel({ client }: { client: CustomizationClient }) {
  const message = useMessage();
  const [settings, setSettings] = useState<SkillSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installMode, setInstallMode] = useState<"paste" | "folder">("paste");
  const [markdown, setMarkdown] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [enabledOnInstall, setEnabledOnInstall] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState<InstalledSkill | null>(null);

  const clientName = CLIENT_NAMES[client];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await api.skills());
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<SkillSettings>, success?: string) => {
    try {
      setSettings(await action());
      if (success) message(success);
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const pickDirectory = async () => {
    try {
      const directory = await api.pickDirectory();
      if (directory) setSourcePath(directory);
    } catch (cause) {
      message(errorText(cause));
    }
  };

  const install = async () => {
    const enabledClaude = client === "claude" && enabledOnInstall;
    const enabledCodex = client === "codex" && enabledOnInstall;
    if (installMode === "paste" && !markdown.trim()) {
      message(t("请先粘贴 SKILL.md 内容"));
      return;
    }
    if (installMode === "folder" && !sourcePath.trim()) {
      message(t("请先选择 Skill 目录"));
      return;
    }
    setInstalling(true);
    try {
      const next = installMode === "paste"
        ? await api.pasteSkill({ markdown, enabled_claude: enabledClaude, enabled_codex: enabledCodex })
        : await api.installSkill({ source_path: sourcePath.trim(), enabled_claude: enabledClaude, enabled_codex: enabledCodex });
      setSettings(next);
      setInstallOpen(false);
      setMarkdown("");
      setSourcePath("");
      message(t("Skill 已安装"));
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setInstalling(false);
    }
  };

  const paths: SkillClientPaths | undefined = settings?.clients.find((item) => item.client === client);
  const unmanaged = paths?.unmanaged ?? [];

  return <>
    <div className={styles.panel}>
      <div className={styles.summary}>
        <div className={styles.pathLine}>
          <code>{paths?.display_path ?? "…"}</code>
        </div>
        <small>{t("Skill 是一整个文件夹（含 SKILL.md）。主副本保存在 {path}，启用后同步到这里的 skills 目录：优先符号链接，不可用时复制。", { path: settings?.display_path ?? "…" })}</small>
      </div>

      <div className={styles.toolbar}>
        <Button size="small" disabled={loading} onClick={() => void load()}>{t("刷新")}</Button>
        <Button variant="primary" size="small" disabled={loading} onClick={() => setInstallOpen(true)}>{t("安装 Skill")}</Button>
      </div>

      {settings && settings.skills.length === 0 ? (
        <div className={styles.gate}>
          <strong>{t("还没有安装 Skill")}</strong>
          <span>{t("选择一个包含 SKILL.md 的本地文件夹即可安装。")}</span>
        </div>
      ) : (
        <ul className={styles.list}>
          {settings?.skills.map((skill) => (
            <li className={styles.row} key={skill.id} data-enabled={isEnabled(skill, client) || undefined}>
              <div className={styles.identity}>
                <div className={styles.nameLine}>
                  <strong>{skill.name}</strong>
                  <code className={styles.directory}>{skill.directory}</code>
                </div>
                {skill.description && <small>{skill.description}</small>}
              </div>
              <div className={styles.rowActions}>
                <TooltipTrigger label={t("在 {name} 中启用", { name: clientName })}>
                  <Switch
                    checked={isEnabled(skill, client)}
                    disabled={loading}
                    label={clientName}
                    onChange={(checked) => void run(
                      () => api.setSkillEnabled(skill.id, client, checked),
                      checked
                        ? t("已在 {name} 中启用「{name2}」", { name: clientName, name2: skill.name })
                        : t("已从 {name} 中撤下「{name2}」", { name: clientName, name2: skill.name }),
                    )}
                  />
                </TooltipTrigger>
                <button type="button" className={styles.textButton} onClick={() => setUninstalling(skill)}>
                  {t("卸载")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {unmanaged.length > 0 && <div className={styles.unmanaged}>
        <strong>{t("目录中发现未纳管的 Skill")}</strong>
        <small>{t("这些文件夹已在 {name} 的 skills 目录里，但不由本应用管理。导入后会复制成主副本，并按需启用。", { name: clientName })}</small>
        <ul>
          {unmanaged.map((directory) => (
            <li key={directory}>
              <code>{directory}</code>
              <button
                type="button"
                className={styles.textButton}
                disabled={loading}
                onClick={() => void run(
                  () => api.importSkill(client, directory, client === "claude", client === "codex"),
                  t("已导入「{name}」", { name: directory }),
                )}
              >
                {t("导入")}
              </button>
            </li>
          ))}
        </ul>
      </div>}
    </div>

    <Modal
      open={installOpen}
      busy={installing}
      wide
      title={t("安装 Skill")}
      onClose={() => setInstallOpen(false)}
      onSubmit={() => void install()}
      submitLabel={t("安装")}
    >
      <div className={styles.editor}>
        <div className={styles.modeSwitch} role="group" aria-label={t("安装方式")}>
          <button type="button" aria-pressed={installMode === "paste"} onClick={() => setInstallMode("paste")}>{t("粘贴 Markdown")}</button>
          <button type="button" aria-pressed={installMode === "folder"} onClick={() => setInstallMode("folder")}>{t("本地文件夹")}</button>
        </div>
        {installMode === "paste" ? (
          <FormField label="SKILL.md" hint={t("直接粘贴完整的 Markdown。开头的 front matter 必须提供 name，它决定目录名；description 会显示在列表里。")}>
            <TextArea
              rows={14}
              value={markdown}
              placeholder={"---\nname: release-notes\ndescription: 把提交整理成发版说明\n---\n\n## 步骤\n\n1. …"}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </FormField>
        ) : (
          <FormField label={t("Skill 目录")} hint={t("文件夹中必须直接包含 SKILL.md；适合带脚本或其他附件的 Skill。")}>
            <div className={styles.pathInput}>
              <TextInput
                value={sourcePath}
                placeholder={t("例如：/Users/me/skills/my-skill")}
                onChange={(event) => setSourcePath(event.target.value)}
              />
              <Button size="small" onClick={() => void pickDirectory()}>
                <Icon icon={folderOpenIcon} size="1.1em" />
                {t("选择…")}
              </Button>
            </div>
          </FormField>
        )}
        <label className={styles.toggle}>
          <Switch checked={enabledOnInstall} label={clientName} onChange={setEnabledOnInstall} />
          <span>{t("安装后在 {name} 中启用", { name: clientName })}</span>
        </label>
      </div>
    </Modal>

    <ConfirmDialog
      open={uninstalling !== null}
      title={t("卸载 Skill")}
      cancelLabel={t("取消")}
      confirmLabel={t("卸载")}
      onCancel={() => setUninstalling(null)}
      onConfirm={() => {
        const target = uninstalling;
        setUninstalling(null);
        if (target) void run(() => api.uninstallSkill(target.id), t("已卸载「{name}」", { name: target.name }));
      }}
    >
      <p>{t("确定卸载「{name}」吗？主副本与各客户端里的副本都会被删除。", { name: uninstalling?.name ?? "" })}</p>
    </ConfirmDialog>
  </>;
}