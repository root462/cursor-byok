import styles from "./DynamicBackdrop.module.scss";

export function DynamicBackdrop() {
  return (
    <div className={styles.dynamicBackdrop} aria-hidden="true">
      <div className={styles.backdropBase} />
      <div className={styles.backdropMesh}>
        <div className={`${styles.orb} ${styles.orb1}`} />
        <div className={`${styles.orb} ${styles.orb2}`} />
        <div className={`${styles.orb} ${styles.orb3}`} />
        <div className={`${styles.orb} ${styles.orb4}`} />
        <div className={`${styles.orb} ${styles.orb5}`} />
      </div>
      <div className={styles.backdropVeil} />
    </div>
  );
}
