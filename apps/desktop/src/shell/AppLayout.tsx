import { useLayoutEffect, useRef, useState } from "react";
import type { IconifyIcon } from "@iconify/react/offline";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import { NavLink, useLocation } from "react-router-dom";
import cursorIconUrl from "../shared/assets/icons/cursor.svg";
import claudeIconUrl from "../shared/assets/icons/claude.svg";
import codexIconUrl from "../shared/assets/icons/codex.svg";
import { PageLayout } from "./layout/PageLayout";
import { Card } from "../shared/ui/Card";
import { Icon } from "../shared/ui/Icon";
import {
  menuCallsIcon,
  menuOverviewIcon,
  menuPluginsIcon,
  menuSettingsIcon,
} from "../shared/ui/icons";
import { VirtualList } from "../shared/virtual/VirtualList";
import { useAppStore } from "../shared/store/appStore";
import { updateStore, useUpdateStore } from "../shared/store/updateStore";
import styles from "./AppLayout.module.scss";
import { createStickyNavigationKeyframes } from "./stickyNavigationMotion";
import { PageActionsTarget } from "./PageActions";
import { ActiveRouteContext } from "./ActiveRouteContext";
import { ModelDragProvider, useModelDrag } from "../features/models/ModelDrag";
import { modelClients, type ModelClient } from "../features/models/modelCopy";

type MenuItemPage = { kind: "page"; path: string; label: string; icon: IconifyIcon | string; client?: ModelClient };
type MenuItem =
  | MenuItemPage
  | { kind: "group"; label: string };

const keptAlivePages = ["/", "/calls", "/settings", "/harness/cursor", "/harness/claude", "/harness/codex", "/plugins"];

function NavigationRow({
  item,
  cursorHarness,
  claudeHarness,
  codexHarness,
  availableVersion,
}: {
  item: MenuItemPage;
  cursorHarness: ReturnType<typeof useAppStore>["cursorHarness"];
  claudeHarness: ReturnType<typeof useAppStore>["claudeHarness"];
  codexHarness: ReturnType<typeof useAppStore>["codexHarness"];
  availableVersion: string | null;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const { source, over } = useModelDrag();
  const dropState = source && item.client && source !== item.client
    ? (over === item.client ? "over" : "available")
    : undefined;

  const handleMouseEnter = () => {
    if (containerRef.current && textRef.current) {
      const diff = textRef.current.scrollWidth - containerRef.current.clientWidth;
      if (diff > 1) {
        setOverflow(diff);
      }
    }
  };

  const handleMouseLeave = () => {
    setOverflow(0);
  };

  return (
    <div className={styles.navigationRow} key={item.path}>
      <NavLink
        to={item.path}
        end={item.path === "/"}
        title={item.label}
        data-model-client={item.client}
        data-model-drop={dropState}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {() => (
          <>
            {typeof item.icon === "string" ? (
              <Icon className={styles.menuBrandIcon} src={item.icon} size="1.3em" />
            ) : (
              <Icon className={styles.menuIcon} icon={item.icon} size="1.3em" />
            )}
            <span
              ref={containerRef}
              className={styles.menuLabelContainer}
              data-scrolling={overflow > 0 || undefined}
            >
              <span
                ref={textRef}
                className={`${styles.menuLabelText} ${overflow > 0 ? styles.menuLabelMarquee : ""}`}
                style={
                  overflow > 0
                    ? ({ "--marquee-offset": `-${overflow + 4}px` } as React.CSSProperties)
                    : undefined
                }
              >
                {item.label}
              </span>
            </span>
            {item.path === "/harness/cursor" && cursorHarness && (
              <span
                className={styles.menuStatusTag}
                data-taken={cursorHarness.settings_applied || undefined}
              >
                {cursorHarness.settings_applied ? t("已接管") : t("未接管")}
              </span>
            )}
            {item.path === "/harness/claude" && claudeHarness && (
              <span
                className={styles.menuStatusTag}
                data-taken={claudeHarness.settings_applied || undefined}
              >
                {claudeHarness.settings_applied ? t("已接管") : t("未接管")}
              </span>
            )}
            {item.path === "/harness/codex" && codexHarness && (
              <span
                className={styles.menuStatusTag}
                data-taken={codexHarness.settings_applied || undefined}
              >
                {codexHarness.settings_applied ? t("已接管") : t("未接管")}
              </span>
            )}
            {item.path === "/settings" && availableVersion && (
              <span className={styles.menuIndicatorDot} aria-hidden="true" />
            )}
          </>
        )}
      </NavLink>
    </div>
  );
}

export function AppLayout() {
  return <ModelDragProvider><AppLayoutContent /></ModelDragProvider>;
}

function AppLayoutContent() {
  const { cursorHarness, claudeHarness, codexHarness } = useAppStore();
  const { availableVersion, installing } = useUpdateStore();
  const location = useLocation();
  const navigationRef = useRef<HTMLElement>(null);
  const activePillRef = useRef<HTMLSpanElement>(null);
  const syncActivePillRef = useRef<((animate: boolean) => void) | null>(null);
  const activePillInitializedRef = useRef(false);
  const activePillAnimationRef = useRef<Animation | null>(null);
  const activePillScrollFrameRef = useRef<number | null>(null);
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  const menuItems: MenuItem[] = [
    { kind: "page", path: "/", label: t("驾驶舱"), icon: menuOverviewIcon },
    { kind: "page", path: "/calls", label: t("调用详细"), icon: menuCallsIcon },
    { kind: "group", label: t("模型配置") },
    { kind: "page", path: "/harness/cursor", label: modelClients.cursor, icon: cursorIconUrl, client: "cursor" },
    { kind: "page", path: "/harness/claude", label: modelClients.claude, icon: claudeIconUrl, client: "claude" },
    { kind: "page", path: "/harness/codex", label: modelClients.codex, icon: codexIconUrl, client: "codex" },
    { kind: "group", label: t("设置") },
    { kind: "page", path: "/plugins", label: t("插件配置"), icon: menuPluginsIcon },
    { kind: "page", path: "/settings", label: t("系统设置"), icon: menuSettingsIcon },
  ];

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    const pill = activePillRef.current;
    if (!navigation || !pill) return;
    const scrollHost = navigation.querySelector<HTMLElement>("[data-scrolled]");
    const scrollViewport = scrollHost?.firstElementChild as HTMLElement | null;
    if (!scrollViewport) return;

    let previousTarget = "";
    let resizeObserver: ResizeObserver | null = null;
    const syncPill = (animate: boolean) => {
      const activeLink = navigation.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!activeLink) {
        pill.style.visibility = "hidden";
        activePillAnimationRef.current?.cancel();
        activePillAnimationRef.current = null;
        previousTarget = "";
        return;
      }
      const wasVisible = pill.style.visibility === "visible";
      pill.style.visibility = "visible";
      resizeObserver?.observe(activeLink);

      const navigationRect = navigation.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      const currentRect = pill.getBoundingClientRect();
      const targetX = linkRect.left - navigationRect.left;
      const targetY = linkRect.top - navigationRect.top;
      const targetWidth = linkRect.width;
      const targetHeight = linkRect.height;
      const previousX = currentRect.left - navigationRect.left;
      const previousY = currentRect.top - navigationRect.top;
      const deltaX = targetX - previousX;
      const deltaY = targetY - previousY;
      const target = `${targetX},${targetY},${targetWidth},${targetHeight}`;
      // Layout notifications must not cancel an in-progress route animation
      // when the destination itself has not moved.
      if (!animate && target === previousTarget) return;
      previousTarget = target;

      activePillAnimationRef.current?.cancel();
      activePillAnimationRef.current = null;
      pill.style.setProperty("--active-pill-width", `${targetWidth}px`);
      pill.style.setProperty("--active-pill-height", `${targetHeight}px`);
      pill.style.setProperty("--active-pill-x", `${targetX}px`);
      pill.style.setProperty("--active-pill-y", `${targetY}px`);

      const hasPreviousPill = wasVisible && (Math.abs(deltaX) >= 1 || Math.abs(deltaY) >= 1);
      if (
        !animate || !hasPreviousPill ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) return;

      // Move the glass capsule as one elastic body: it leads in the travel
      // direction, stretches through the journey, then rebounds onto the row.
      const distance = Math.hypot(deltaX, deltaY);
      const animation = pill.animate(
        createStickyNavigationKeyframes(
          {
            x: previousX,
            y: previousY,
            width: currentRect.width,
            height: currentRect.height,
          },
          {
            x: targetX,
            y: targetY,
            width: targetWidth,
            height: targetHeight,
          },
        ),
        { duration: Math.min(680, Math.max(500, 420 + distance * 0.3)), easing: "linear" },
      );
      activePillAnimationRef.current = animation;
      animation.onfinish = () => {
        if (activePillAnimationRef.current === animation) {
          activePillAnimationRef.current = null;
          animation.cancel();
        }
      };
    };

    syncPill(false);
    const syncWithoutMotion = () => syncPill(false);
    let scrollEndTimer: number | null = null;
    const syncOnScroll = () => {
      pill.dataset.scrolling = "true";
      if (activePillScrollFrameRef.current !== null) {
        cancelAnimationFrame(activePillScrollFrameRef.current);
      }
      activePillScrollFrameRef.current = requestAnimationFrame(() => {
        activePillScrollFrameRef.current = null;
        syncWithoutMotion();
      });
      if (scrollEndTimer !== null) window.clearTimeout(scrollEndTimer);
      scrollEndTimer = window.setTimeout(() => {
        delete pill.dataset.scrolling;
        scrollEndTimer = null;
      }, 140);
    };
    scrollViewport.addEventListener("scroll", syncOnScroll, { passive: true });
    resizeObserver = new ResizeObserver(syncWithoutMotion);
    resizeObserver.observe(navigation);
    window.addEventListener("resize", syncWithoutMotion);
    syncActivePillRef.current = syncPill;

    return () => {
      scrollViewport.removeEventListener("scroll", syncOnScroll);
      if (activePillScrollFrameRef.current !== null) {
        cancelAnimationFrame(activePillScrollFrameRef.current);
        activePillScrollFrameRef.current = null;
      }
      if (scrollEndTimer !== null) window.clearTimeout(scrollEndTimer);
      delete pill.dataset.scrolling;
      window.removeEventListener("resize", syncWithoutMotion);
      resizeObserver.disconnect();
      syncActivePillRef.current = null;
      activePillAnimationRef.current?.cancel();
      activePillAnimationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const animate = activePillInitializedRef.current;
    activePillInitializedRef.current = true;
    syncActivePillRef.current?.(animate);
  }, [location.pathname]);

  return <PageLayout className={styles.root}>
    <Card as="aside" className={styles.menuCard}>
      <nav ref={navigationRef} className={styles.navigation} aria-label={t("主菜单")}>
        <span ref={activePillRef} className={styles.activePill} aria-hidden="true" />
        <VirtualList
          items={menuItems}
          itemKey={(item) => item.kind === "group" ? `group-${item.label}` : item.path}
          estimatedItemHeight={36}
          itemGap={3}
          className={`${styles.navigationList} scroll-shadow-bottom`}
        >
          {(item) => item.kind === "group"
          ? <div className={styles.navigationGroup} key={`group-${item.label}`}>{item.label}</div>
          : <NavigationRow
              key={item.path}
              item={item}
              cursorHarness={cursorHarness}
              claudeHarness={claudeHarness}
              codexHarness={codexHarness}
              availableVersion={availableVersion}
            />}
        </VirtualList>
        {availableVersion && (
          <div className={styles.bottomUpdateCard} role="status">
            <div className={styles.bottomUpdateHeader}>
              <div className={styles.bottomUpdateText}>
                <span className={styles.bottomUpdateTitle}>{t("发现新版本")}</span>
                <span className={styles.bottomUpdateVersion}>v{availableVersion}</span>
              </div>
            </div>
            <div className={styles.bottomUpdateActions}>
              <button
                type="button"
                className={styles.bottomUpdateInstallBtn}
                disabled={installing}
                onClick={() => void updateStore.install()}
              >
                {installing ? t("安装中…") : t("立即升级")}
              </button>
            </div>
          </div>
        )}
      </nav>
    </Card>
    <main className={styles.content}>
      <div className={styles.actionRegion}>
        {/* 这里不能用 Card：Card 的 .root 声明了 padding: 0，和 .liquid 的
            padding: var(--liquid-padding) 同属单类选择器，谁在样式表后面谁赢。
            打包后 Card 的规则在后，工具条的内边距会被清零，端头元素就贴住玻璃边缘。
            .actions 自己就 composes 了 liquid，用裸 div 才是唯一可靠的形态。 */}
        <div className={styles.actions}>
          <div ref={setLeftActionTarget} className={styles.pageActions} />
          <div ref={setRightActionTarget} className={styles.pageActions} />
        </div>
      </div>
      <PageActionsTarget.Provider value={{ left: leftActionTarget, right: rightActionTarget }}>
        <ActiveRouteContext.Provider value={location.pathname}>
          <KeepAliveRouteOutlet
            activeCacheKey={location.pathname}
            include={keptAlivePages}
            max={keptAlivePages.length}
            enableActivity
            containerClassName={styles.keepAliveContainer}
            cacheNodeClassName={styles.keepAlivePage}
          />
        </ActiveRouteContext.Provider>
      </PageActionsTarget.Provider>
    </main>
  </PageLayout>;
}
