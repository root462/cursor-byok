import type { DesktopPlatform } from "../shared/native/platform";
import { WindowControls } from "./WindowControls";
import { MacTrafficLights } from "./MacTrafficLights";
import styles from "./AppHeader.module.scss";

type AppHeaderProps = {
  platform: DesktopPlatform;
  nativeDesktop: boolean;
};

export function AppHeader({ platform, nativeDesktop }: AppHeaderProps) {
  const showMacTrafficLights = !nativeDesktop && platform === "macos";
  const showWindowControls = nativeDesktop && platform !== "macos";

  return <header className={styles.root}>
    <div className={styles.dragLayer} data-tauri-drag-region aria-hidden="true" />
    <div className={styles.uiLayer}>
      {showMacTrafficLights && <MacTrafficLights />}
      {showWindowControls && <div className={styles.windowControls}><WindowControls /></div>}
    </div>
  </header>;
}
