import type { ModelConnectivityResult } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { informationOutlineIcon } from "../../shared/ui/icons";
import styles from "./CursorModelTestResult.module.scss";

export type CursorModelTestState =
  | { status: "success"; result: ModelConnectivityResult }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export function CursorModelTestResult({ state, note, testing = false, compact = false }: {
  state?: CursorModelTestState;
  note: string;
  testing?: boolean;
  /** 列表行内的紧凑徽标形态。 */
  compact?: boolean;
}) {
  if (testing) {
    return <span className={`${compact ? styles.compact : styles.root} ${styles.testing}`} role="status">
      <svg className={styles.testingRing} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className={styles.ringTrack} cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" />
        <circle className={styles.ringArc} cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className={styles.summary}>{t("测试中…")}</span>
    </span>;
  }
  if (!state) {
    const summary = note.trim();
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{summary}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{summary}</span></div>;
  }
  if (state.status === "cancelled") {
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{t("测试已取消")}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{t("测试已取消")}</span></div>;
  }

  const success = state.status === "success";
  const summary = success
    ? t("速度：{speed} tokens/s", { speed: formatSpeed(state.result.tokens_per_second) })
    : t("错误：{error}", { error: state.error });
  const detail = success
    ? t("速度 {speed} tokens/s · 首字 {firstText} ms · 总耗时 {duration} ms · 输出 {tokens} tokens{estimated} · 返回：{output}", {
      speed: formatSpeed(state.result.tokens_per_second),
      firstText: state.result.first_valid_response_ms ?? "--",
      duration: state.result.duration_ms,
      tokens: state.result.output_tokens,
      estimated: state.result.tokens_estimated ? t("（估算）") : "",
      output: state.result.output || "--",
    })
    : t("测试失败：{error}", { error: state.error });

  if (compact) {
    return <TooltipTrigger label={detail}>
      <span className={`${styles.compact} ${success ? styles.success : styles.error}`}>
        {success ? `${formatSpeed(state.result.tokens_per_second)} tokens/s` : t("测试失败")}
        <Icon icon={informationOutlineIcon} size="1em" />
      </span>
    </TooltipTrigger>;
  }

  return <div className={`${styles.root} ${success ? styles.success : styles.error}`}>
    <span className={styles.summary}>{summary}</span>
    <TooltipTrigger label={detail}><button type="button" className={styles.details}>{t("查看详情")}<Icon icon={informationOutlineIcon} size="1.1em" /></button></TooltipTrigger>
  </div>;
}

function formatSpeed(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
