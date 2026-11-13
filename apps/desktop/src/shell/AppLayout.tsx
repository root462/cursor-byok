import { useRef, useState } from "react";
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
  menuCallsActiveIcon,
  menuCallsIcon,
  menuOverviewActiveIcon,
  menuOverviewIcon,
  menuPluginsActiveIcon,
  menuPluginsIcon,
  menuSettingsActiveIcon,
  menuSettingsIcon,
} from "../shared/ui/icons";
import { VirtualList } from "../shared/virtual/VirtualList";
import { useAppStore } from "../shared/store/appStore";
import { updateStore, useUpdateStore } from "../shared/store/updateStore";
import styles from "./AppLayout.module.scss";
import { PageActionsTarget } from "./PageActions";

type MenuItemPage = { kind: "page"; path: string; label: string; icon: IconifyIcon | string; activeIcon?: IconifyIcon };
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
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {({ isActive }) => (
          <>
            {typeof item.icon === "string" ? (
              <Icon className={styles.menuBrandIcon} src={item.icon} size="1.3em" />
            ) : (
              <Icon
                className={styles.menuIcon}
                icon={isActive && item.activeIcon ? item.activeIcon : item.icon}
                size="1.3em"
              />
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
  const { cursorHarness, claudeHarness, codexHarness } = useAppStore();
  const { availableVersion, installing } = useUpdateStore();
  const location = useLocation();
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  const menuItems: MenuItem[] = [
    { kind: "page", path: "/", label: t("驾驶舱"), icon: menuOverviewIcon, activeIcon: menuOverviewActiveIcon },
    { kind: "page", path: "/calls", label: t("调用详细"), icon: menuCallsIcon, activeIcon: menuCallsActiveIcon },
    { kind: "group", label: t("模型配置") },
    { kind: "page", path: "/harness/cursor", label: "Cursor", icon: cursorIconUrl },
    { kind: "page", path: "/harness/claude", label: "Claude CLI", icon: claudeIconUrl },
    { kind: "page", path: "/harness/codex", label: "Codex Desktop", icon: codexIconUrl },
    { kind: "group", label: t("设置") },
    { kind: "page", path: "/plugins", label: t("插件配置"), icon: menuPluginsIcon, activeIcon: menuPluginsActiveIcon },
    { kind: "page", path: "/settings", label: t("系统设置"), icon: menuSettingsIcon, activeIcon: menuSettingsActiveIcon },
  ];

  return <PageLayout className={styles.root}>
    <Card as="aside" className={styles.menuCard}>
      <nav className={styles.navigation} aria-label={t("主菜单")}>
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
        <KeepAliveRouteOutlet
          activeCacheKey={location.pathname}
          include={keptAlivePages}
          max={keptAlivePages.length}
          enableActivity
          containerClassName={styles.keepAliveContainer}
          cacheNodeClassName={styles.keepAlivePage}
        />
      </PageActionsTarget.Provider>
    </main>
  </PageLayout>;
}
