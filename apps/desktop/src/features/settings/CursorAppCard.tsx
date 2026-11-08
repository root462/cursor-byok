import { useCallback, useEffect, useState } from "react";
import cursorIconUrl from "../../shared/assets/icons/cursor.svg";
import { api, type CursorAppInfo } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./CursorAppCard.module.scss";

/**
 * Shows the Cursor build installed on this machine. The probe runs on the
 * local management server, so it reports the real install even when Cursor is
 * not running.
 *
 * A failed probe must not read as "not installed": an unreachable management
 * server and a missing Cursor install need different fixes.
 */
export function CursorAppCard() {
  const [info, setInfo] = useState<CursorAppInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      setInfo(await api.cursorAppInfo());
    } catch (cause) {
      setInfo(null);
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const installed = Boolean(info?.installed);
  const pending = busy && !info;
  const badge = pending ? t("检测中…") : failure ? t("检测失败") : installed ? t("已安装") : t("未检测到");
  const build = info?.build ?? null;
  const tone = pending ? "pending" : failure ? "error" : installed ? "ok" : "muted";

  return <TitledCard
    title={<div className={styles.title}><Icon src={cursorIconUrl} size="1.1em" /><span>{t("Cursor 应用")}</span></div>}
    action={
      <button type="button" className={styles.headerAction} disabled={busy} onClick={() => void load()}>
        {busy ? t("检测中…") : t("重新检测")}
      </button>
    }
  >
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.description}>
          <strong>{t("本机 Cursor")}</strong>
          <small>{t("读取本机安装的 Cursor 版本，用于核对兼容性。")}</small>
        </div>
        <span className={styles.badge} data-tone={tone}>{badge}</span>
      </div>
      {installed && <>
        <div className={styles.row}>
          <strong>{t("版本")}</strong>
          <span className={styles.value}>{info?.version ?? t("未知")}</span>
        </div>
        <div className={styles.row}>
          <strong>{t("构建")}</strong>
          <span className={styles.value}>{build ? build.slice(0, 9) : t("未知")}</span>
        </div>
        <div className={styles.row}>
          <strong>{t("运行状态")}</strong>
          <span className={styles.value}>{info?.running ? t("运行中") : t("未运行")}</span>
        </div>
        <div className={styles.row}>
          <strong>{t("安装位置")}</strong>
          <span className={`${styles.value} ${styles.path}`} title={info?.app_root ?? undefined}>{info?.app_root ?? t("未知")}</span>
        </div>
      </>}
      {failure && <small className={`${styles.hint} ${styles.failure}`}>{failure}</small>}
      {!installed && !pending && !failure && <small className={styles.hint}>
        {t("未在本机找到 Cursor 安装，安装或启动一次后再点「重新检测」。")}
      </small>}
    </div>
  </TitledCard>;
}
