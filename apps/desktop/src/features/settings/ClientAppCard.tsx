import { useCallback, useEffect, useState } from "react";
import claudeIconUrl from "../../shared/assets/icons/claude.svg";
import codexIconUrl from "../../shared/assets/icons/codex.svg";
import { api, type ClaudeHarnessStatus, type ClientAppInfo, type CodexHarnessStatus } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./CursorAppCard.module.scss";

type Client = "claude" | "codex";
type ClientStatus = ClaudeHarnessStatus | CodexHarnessStatus;

export function ClientAppCard({ client }: { client: Client }) {
  const [info, setInfo] = useState<ClientStatus | null>(null);
  const [appInfo, setAppInfo] = useState<ClientAppInfo | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const isClaude = client === "claude";
  const name = isClaude ? "Claude CLI" : "Codex Desktop";
  const icon = isClaude ? claudeIconUrl : codexIconUrl;

  const load = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const [statusResult, appResult, runningResult] = await Promise.allSettled([
        isClaude ? api.claudeHarness() : api.codexHarness(),
        isClaude ? api.claudeAppInfo() : api.codexAppInfo(),
        isClaude ? Promise.resolve(null) : api.codexRunning(),
      ]);
      if (statusResult.status === "fulfilled") {
        setInfo(statusResult.value);
        setFailure(null);
      } else {
        setInfo(null);
        setFailure(statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason));
      }
      setAppInfo(appResult.status === "fulfilled" ? appResult.value : null);
      setRunning(runningResult.status === "fulfilled" ? runningResult.value?.running ?? null : null);
    } catch (cause) {
      setInfo(null);
      setAppInfo(null);
      setRunning(null);
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [isClaude]);

  useEffect(() => { void load(); }, [load]);

  const pending = busy && !appInfo;
  const installed = appInfo?.installed ?? null;
  const badge = pending ? t("检测中…") : installed === null ? t("未知") : installed ? t("已安装") : t("未检测到");
  const tone = pending ? "pending" : installed === null ? "muted" : installed ? "ok" : "muted";
  const version = appInfo?.version ?? (installed === false ? t("未检测到") : t("未知"));
  const configPath = info?.config_path;

  return <TitledCard
    title={<div className={styles.title}><Icon src={icon} size="1.1em" /><span>{name}</span></div>}
    action={<button type="button" className={styles.headerAction} disabled={busy} onClick={() => void load()}>{busy ? t("检测中…") : t("重新检测")}</button>}
  >
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.description}><strong>{name}</strong><small>{t("检查本机安装和接管配置状态。")}</small></div>
        <span className={styles.badge} data-tone={tone}>{badge}</span>
      </div>
      <div className={styles.row}><strong>{t("版本")}</strong><span className={styles.value}>{version}</span></div>
      {info && <>
        <div className={styles.row}><strong>{t("接管状态")}</strong><span className={styles.value}>{info.settings_applied ? t("已接管") : t("未接管")}</span></div>
        <div className={styles.row}><strong>{t("已配置模型")}</strong><span className={styles.value}>{info.configured_models}</span></div>
        {!isClaude && <div className={styles.row}><strong>{t("运行状态")}</strong><span className={styles.value}>{running === null ? t("未知") : running ? t("运行中") : t("未运行")}</span></div>}
        <div className={styles.row}><strong>{t("配置位置")}</strong><span className={`${styles.value} ${styles.path}`} title={configPath}>{configPath}</span></div>
      </>}
      {failure && <small className={`${styles.hint} ${styles.failure}`}>{failure}</small>}
    </div>
  </TitledCard>;
}
