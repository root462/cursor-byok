import { useCallback, useEffect, useMemo, useState } from "react";
import type { LlmCall } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { CallTable } from "./CallTable";
import { createCallColumns } from "./callColumns";
import { loadHiddenColumns, saveHiddenColumns } from "./columnVisibility";
import styles from "./CallsPage.module.scss";

const CALL_REFRESH_INTERVAL_MS = 2_000;

export function CallsPage() {
  const { calls } = useAppStore();
  const onDetails = useCallback((call: LlmCall) => void appStore.openCallDetails(call.call_id), []);
  const columns = useMemo(() => createCallColumns(onDetails), [onDetails]);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(() =>
    loadHiddenColumns(new Set(columns.filter((spec) => spec.defaultHidden).map((spec) => spec.key))),
  );
  const updateHiddenColumns = useCallback((next: ReadonlySet<string>) => {
    setHiddenColumns(next);
    saveHiddenColumns(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshCalls = () => {
      if (!disposed && document.visibilityState === "visible") {
        void appStore.refreshCalls();
      }
    };

    refreshCalls();
    const interval = window.setInterval(refreshCalls, CALL_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshCalls);
    document.addEventListener("visibilitychange", refreshCalls);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshCalls);
      document.removeEventListener("visibilitychange", refreshCalls);
    };
  }, []);

  const content = <div className={styles.page}>
    <CallTable
      calls={calls}
      columns={columns}
      hidden={hiddenColumns}
      onHiddenChange={updateHiddenColumns}
    />
  </div>;
  return <PageContent
    flushTop
    fixed
    contentClassName={styles.pageContent}
    sections={[{ key: "calls", estimatedHeight: 720, content }]}
  />;
}
