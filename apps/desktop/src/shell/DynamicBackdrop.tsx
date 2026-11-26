import styles from "./DynamicBackdrop.module.scss";

export function DynamicBackdrop() {
  return <div className={styles.dynamicBackdrop} aria-hidden="true" />;
}
