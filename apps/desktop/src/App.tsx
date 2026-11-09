import { useEffect, useRef } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "./shared/ui/Tooltip";
import { MessageProvider } from "./shared/ui/MessageProvider";
import { useMessage } from "./shared/ui/message";
import { AppFrame } from "./shell/AppFrame";
import { AppLayout } from "./shell/AppLayout";
import { CallsPage } from "./features/calls/CallsPage";
import { CallDetailsPage } from "./features/calls/CallDetailsPage";
import { CursorSettingsPage } from "./features/models/CursorSettingsPage";
import { HomePage } from "./features/home/HomePage";
import { PluginManagementPage } from "./features/plugins/PluginManagementPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TabSettingsPage } from "./features/tab/TabSettingsPage";
import { appStore, useAppStore } from "./shared/store/appStore";
import { updateStore } from "./shared/store/updateStore";

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const AUTO_UPDATE_RETRY_BASE_MS = 30 * 1_000;
const AUTO_UPDATE_RETRY_MAX_MS = 30 * 60 * 1_000;
const AUTO_UPDATE_RETRY_MAX_DOUBLINGS = 8;

export function App() {
  return (
    <TooltipProvider>
      <HashRouter>
        <Routes>
          <Route path="calls/:callId" element={<CallDetailsPage />} />
          <Route element={<AppFrame />}>
            <Route element={<AppLayout />}>
              <Route index element={<HomePage />} />
              <Route path="calls" element={<CallsPage />} />
              <Route path="harness/cursor" element={<CursorSettingsPage />} />
              <Route path="plugins" element={<PluginManagementPage />} />
              <Route path="tab" element={<TabSettingsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <AppMessages />
    </TooltipProvider>
  );
}

function AppMessages() {
  const { error, cursorRuntime } = useAppStore();
  const lastRuntimeWarning = useRef(0);
  const previousError = useRef<string | null>(null);
  const showMessage = useMessage();

  useEffect(() => {
    if (error && error !== previousError.current) showMessage(error);
    previousError.current = error;
  }, [error, showMessage]);

  useEffect(() => {
    if (!cursorRuntime) return;
    if (cursorRuntime.mismatch_count > lastRuntimeWarning.current) {
      showMessage(t("检测到 Cursor 本地编排，已请求客户端安全切回后端 Agent；若仍失败，请在 Cursor 配置页查看恢复说明。"), { duration: 8_000 });
    }
    lastRuntimeWarning.current = cursorRuntime.mismatch_count;
  }, [cursorRuntime, showMessage]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void appStore.refreshCursorRuntimeStatus();
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;
    let failedChecks = 0;
    let nextAttemptAt = 0;

    const clearRetry = () => {
      window.clearTimeout(retryTimer);
      retryTimer = 0;
    };

    // 自动检查失败后按指数退避重试：30s、1m、2m…封顶 30min。
    // 断网时不排定时器，交给 online 事件立即补一次。
    const scheduleRetry = () => {
      clearRetry();
      if (disposed || !navigator.onLine) return;
      const delay = Math.min(
        AUTO_UPDATE_RETRY_BASE_MS * 2 ** Math.min(failedChecks, AUTO_UPDATE_RETRY_MAX_DOUBLINGS),
        AUTO_UPDATE_RETRY_MAX_MS,
      );
      failedChecks += 1;
      nextAttemptAt = Date.now() + delay;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        nextAttemptAt = 0;
        checkAutomatically();
      }, delay);
    };

    const checkAutomatically = () => {
      if (disposed) return;
      const now = Date.now();
      if (now < nextAttemptAt) return;
      nextAttemptAt = now + AUTO_UPDATE_CHECK_INTERVAL_MS;
      const previousVersion = updateStore.getSnapshot().availableVersion;
      void updateStore.check().then((version) => {
        failedChecks = 0;
        clearRetry();
        if (disposed || !version || version === previousVersion) return;
        showMessage(t("发现新版本 {version}，可在设置中安装", { version }), { duration: 6_000 });
      }).catch(() => {
        if (disposed) return;
        // 失败不打扰用户，但放开节流并按退避排下一次重试；手动检查在设置页报错。
        nextAttemptAt = 0;
        scheduleRetry();
      });
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkAutomatically();
    };

    checkAutomatically();
    window.addEventListener("focus", checkAutomatically);
    window.addEventListener("online", checkAutomatically);
    document.addEventListener("visibilitychange", checkWhenVisible);
    const timer = window.setInterval(checkAutomatically, AUTO_UPDATE_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearRetry();
      window.removeEventListener("focus", checkAutomatically);
      window.removeEventListener("online", checkAutomatically);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.clearInterval(timer);
    };
  }, [showMessage]);

  return <MessageProvider />;
}
