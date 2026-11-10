import { useEffect, useState } from "react";
import { describeUpdateError, hasNativeAppLifecycle, type ReleaseInfo } from "../../shared/native/appLifecycle";
import { updateStore, useUpdateStore } from "../../shared/store/updateStore";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Modal } from "../../shared/ui/Modal";
import { useMessage } from "../../shared/ui/message";
import styles from "./VersionHistoryModal.module.scss";

function parseSemver(v: string): number[] {
  const clean = v.replace(/^v/, "").split("-")[0];
  return clean.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function compareSemver(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "dev") return -1;
  if (b === "dev") return 1;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function VersionHistoryModal({
  open,
  currentVersion,
  onClose,
}: {
  open: boolean;
  currentVersion: string;
  onClose: () => void;
}) {
  const message = useMessage();
  const native = hasNativeAppLifecycle();
  const { history, loadingHistory, historyError, switchingVersion } = useUpdateStore();
  const [targetRelease, setTargetRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    if (open && !history && !loadingHistory) {
      void updateStore.loadHistory().catch((cause) => {
        message(describeUpdateError(cause));
      });
    }
  }, [history, loadingHistory, message, open]);

  const refresh = async () => {
    try {
      await updateStore.loadHistory(true);
      message(t("已刷新版本列表"));
    } catch (cause) {
      message(describeUpdateError(cause));
    }
  };

  const handleConfirmSwitch = async () => {
    if (!targetRelease) return;
    const target = targetRelease;
    setTargetRelease(null);
    try {
      message(t("正在下载并切换至版本 {version}，请稍候…", { version: target.version }));
      await updateStore.switchToVersion(target.version);
    } catch (cause) {
      message(describeUpdateError(cause));
    }
  };

  const isSwitching = switchingVersion !== null;

  return (
    <>
      <Modal
        open={open}
        title={t("版本历史与回退")}
        wide
        closeLabel={t("关闭")}
        onClose={onClose}
      >
        <div className={styles.header}>
          <div className={styles.currentVersion}>
            {t("当前版本：")}
            <strong>v{currentVersion}</strong>
          </div>
          <Button size="small" disabled={loadingHistory || isSwitching} onClick={() => void refresh()}>
            {loadingHistory ? t("加载中…") : t("刷新列表")}
          </Button>
        </div>

        {loadingHistory && !history && (
          <div className={styles.stateBox}>
            <span>{t("正在获取历史版本列表…")}</span>
          </div>
        )}

        {historyError && !history && (
          <div className={styles.stateBox}>
            <span className={styles.errorText}>{historyError}</span>
            <Button size="small" onClick={() => void refresh()}>
              {t("重试")}
            </Button>
          </div>
        )}

        {history && history.length === 0 && (
          <div className={styles.stateBox}>
            <span>{t("暂无历史版本记录")}</span>
          </div>
        )}

        {history && history.length > 0 && (
          <div className={styles.releaseList}>
            {history.map((release) => {
              const diff = compareSemver(release.version, currentVersion);
              const isCurrent = diff === 0;
              const isNewer = diff > 0;
              const isOperating = switchingVersion === release.version;

              return (
                <div key={release.tagName} className={styles.releaseCard}>
                  <div className={styles.releaseCardHeader}>
                    <div className={styles.releaseTitleRow}>
                      <span className={styles.tagName}>{release.tagName}</span>
                      {isCurrent && (
                        <span className={`${styles.badge} ${styles.currentBadge}`}>
                          {t("当前版本")}
                        </span>
                      )}
                      {!isCurrent && isNewer && (
                        <span className={`${styles.badge} ${styles.newerBadge}`}>
                          {t("较新版本")}
                        </span>
                      )}
                      {!isCurrent && !isNewer && (
                        <span className={`${styles.badge} ${styles.olderBadge}`}>
                          {t("历史版本")}
                        </span>
                      )}
                      <span className={styles.releaseDate}>
                        {release.publishedAt ? release.publishedAt.slice(0, 10) : ""}
                      </span>
                    </div>

                    <div>
                      {isCurrent ? (
                        <Button size="small" disabled>
                          {t("当前运行中")}
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          variant={isNewer ? "primary" : "secondary"}
                          disabled={!native || isSwitching}
                          onClick={() => setTargetRelease(release)}
                        >
                          {isOperating
                            ? t("切换中…")
                            : isNewer
                              ? t("升级到此版本")
                              : t("回退到此版本")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {release.body && (
                    <div className={styles.releaseBody}>
                      {release.body}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {targetRelease && (
        <ConfirmDialog
          open={targetRelease !== null}
          title={
            compareSemver(targetRelease.version, currentVersion) < 0
              ? t("回退到历史版本")
              : t("升级到指定版本")
          }
          confirmLabel={
            compareSemver(targetRelease.version, currentVersion) < 0
              ? t("确认回退")
              : t("确认升级")
          }
          cancelLabel={t("取消")}
          onCancel={() => setTargetRelease(null)}
          onConfirm={() => void handleConfirmSwitch()}
        >
          <p>
            {compareSemver(targetRelease.version, currentVersion) < 0
              ? t("确认要将应用回退到版本 {version} 吗？应用将下载该版本安装包并自动重启。", {
                  version: targetRelease.version,
                })
              : t("确认要将应用切换到版本 {version} 吗？应用将下载该版本安装包并自动重启。", {
                  version: targetRelease.version,
                })}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
