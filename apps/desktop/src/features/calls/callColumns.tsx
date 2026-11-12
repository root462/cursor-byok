import type { LlmCall, UsageClient } from "../../shared/api";
import type { ReactNode } from "react";
import type { DataTableColumn } from "../../shared/ui/DataTable";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { eyeIcon } from "../../shared/ui/icons";
import { formatCompactInteger, formatInteger } from "../../shared/utils/numberFormat";
import styles from "./CallTable.module.scss";

const value = (input: string | number | null) => input ?? "-";
const milliseconds = (input: number | null) => input == null ? "-" : `${input} ms`;

function formatCost(value: number | null) {
  if (value == null) return "-";
  if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/** 单次调用的四项 Token 明细；未报告 Token 的调用只显示占位符。 */
function usageSummary(call: LlmCall) {
  if (call.input_tokens == null && call.output_tokens == null) return "-";
  return [
    `${t("输入")} ${formatCompactInteger(call.input_tokens ?? 0)}`,
    `${t("输出")} ${formatCompactInteger(call.output_tokens ?? 0)}`,
    `${t("读缓存")} ${formatCompactInteger(call.cache_read_tokens ?? 0)}`,
    `${t("写缓存")} ${formatCompactInteger(call.cache_write_tokens ?? 0)}`,
  ].join(" · ");
}

/** 悬停提示里的完整 Token 明细与花费，避免窄列截断信息。 */
function usageTooltip(call: LlmCall): ReactNode {
  const rows: Array<[string, number]> = [
    [t("输入"), call.input_tokens ?? 0],
    [t("输出"), call.output_tokens ?? 0],
    [t("读缓存"), call.cache_read_tokens ?? 0],
    [t("写缓存"), call.cache_write_tokens ?? 0],
  ];
  return (
    <span className={styles.usageTooltip}>
      {rows.map(([label, tokens]) => (
        <span key={label} className={styles.usageTooltipRow}>
          <span>{label}</span>
          <span>{formatInteger(tokens)}</span>
        </span>
      ))}
      <span className={styles.usageTooltipRow}>
        <span>{t("估算花费")}</span>
        <span>{call.estimated_cost_usd == null ? "-" : `$${call.estimated_cost_usd.toFixed(6)}`}</span>
      </span>
    </span>
  );
}

/** 调用来源的展示名；未识别的来源原样显示，避免新增客户端时丢失信息。 */
export function clientLabel(client: UsageClient | string): string {
  if (client === "cursor") return "Cursor";
  if (client === "codex") return "Codex";
  if (client === "claude") return "Claude CLI";
  if (client === "external_api") return t("外部 API");
  return client;
}

/** 一列的完整定义：既供表格渲染，也供列显隐面板列出条目。 */
export type CallColumnSpec = {
  key: string;
  /** 列显隐面板里显示的纯文本名称。 */
  label: string;
  /** 固定列不参与显隐切换。 */
  fixed?: boolean;
  /** 首次使用时默认隐藏，但仍可在列面板里打开。 */
  defaultHidden?: boolean;
  column: DataTableColumn<LlmCall>;
};

export function createCallColumns(onDetails: (call: LlmCall) => void): CallColumnSpec[] {
  return [
    {
      key: "status",
      label: t("状态"),
      fixed: true,
      column: {
        key: "status",
        header: t("状态"),
        render: (call) => (
          <span
            className={[styles.status, styles[call.status]]
              .filter(Boolean)
              .join(" ")}
          >
            {call.status}
          </span>
        ),
      },
    },
    {
      key: "actions",
      label: t("操作"),
      fixed: true,
      column: {
        key: "actions",
        header: t("操作"),
        className: styles.actionCol,
        render: (call) => (
          <TooltipTrigger label={t("查看详情")}>
            <button
              className={styles.detailButton}
              aria-label={t("查看详情")}
              onClick={(event) => {
                event.stopPropagation();
                onDetails(call);
              }}
            >
              <Icon icon={eyeIcon} size="1.1em" />
            </button>
          </TooltipTrigger>
        ),
      },
    },
    {
      key: "display_name",
      label: t("显示名称"),
      column: {
        key: "display_name",
        header: t("显示名称"),
        render: (call) => call.display_name,
        title: (call) => call.display_name,
      },
    },
    {
      key: "usage_cost",
      label: t("Token 与花费"),
      column: {
        key: "usage_cost",
        header: t("Token 与花费"),
        className: styles.usageCostCol,
        render: (call) => (
          <TooltipTrigger label={usageTooltip(call)}>
            <span className={styles.usageCost}>
              <span className={styles.usageTokens}>{usageSummary(call)}</span>
              <span className={styles.usagePrice}>{formatCost(call.estimated_cost_usd)}</span>
            </span>
          </TooltipTrigger>
        ),
      },
    },
    {
      key: "created_at",
      label: t("时间"),
      column: {
        key: "created_at",
        header: t("时间"),
        render: (call) => new Date(call.created_at_ms).toLocaleString(),
      },
    },
    {
      key: "model_id",
      label: t("模型名称"),
      column: {
        key: "model_id",
        header: t("模型名称"),
        render: (call) => call.model_id,
        title: (call) => call.model_id,
      },
    },
    {
      key: "reasoning_effort",
      label: t("思考强度"),
      column: {
        key: "reasoning_effort",
        header: t("思考强度"),
        render: (call) => value(call.reasoning_effort),
      },
    },
    {
      key: "fast",
      label: "Fast",
      column: {
        key: "fast",
        header: "Fast",
        render: (call) => call.fast == null ? "-" : call.fast ? t("是") : t("否"),
      },
    },
    {
      key: "call_kind",
      label: t("调用类型"),
      column: {
        key: "call_kind",
        header: t("调用类型"),
        render: (call) => call.call_kind === "cursor_official" ? t("Cursor 官方") : "LLM",
      },
    },
    {
      key: "client",
      label: t("来源"),
      column: {
        key: "client",
        header: t("来源"),
        render: (call) => clientLabel(call.client),
        title: (call) => clientLabel(call.client),
      },
    },
    {
      key: "route",
      label: t("路由"),
      column: {
        key: "route",
        header: t("路由"),
        render: (call) => call.route === "cursor_official" ? t("Cursor 官方") : "BYOK",
      },
    },
    {
      key: "model_hash",
      label: "Model Hash",
      defaultHidden: true,
      column: {
        key: "model_hash",
        header: "Model Hash",
        render: (call) => value(call.model_hash),
        title: (call) => call.model_hash ?? undefined,
      },
    },
    {
      key: "provider_type",
      label: t("上游类型"),
      defaultHidden: true,
      column: {
        key: "provider_type",
        header: t("上游类型"),
        render: (call) => call.provider_type,
      },
    },
    {
      key: "provider_url",
      label: t("上游地址"),
      defaultHidden: true,
      column: {
        key: "provider_url",
        header: t("上游地址"),
        render: (call) => call.provider_url,
        title: (call) => call.provider_url,
      },
    },
    {
      key: "request_type",
      label: t("最终请求类型"),
      defaultHidden: true,
      column: {
        key: "request_type",
        header: t("最终请求类型"),
        render: (call) => call.request_type,
      },
    },
    {
      key: "request_url",
      label: t("最终请求地址"),
      defaultHidden: true,
      column: {
        key: "request_url",
        header: t("最终请求地址"),
        render: (call) => call.request_url,
        title: (call) => call.request_url,
      },
    },
    {
      key: "finish_reason",
      label: "Finish Reason",
      column: {
        key: "finish_reason",
        header: "Finish Reason",
        render: (call) => value(call.finish_reason),
      },
    },
    {
      key: "http",
      label: "HTTP",
      column: {
        key: "http",
        header: "HTTP",
        render: (call) => value(call.http_status),
      },
    },
    {
      key: "duration",
      label: t("耗时"),
      column: {
        key: "duration",
        header: t("耗时"),
        render: (call) => milliseconds(call.duration_ms),
      },
    },
    {
      key: "ttfb",
      label: "TTFB",
      column: {
        key: "ttfb",
        header: "TTFB",
        render: (call) => milliseconds(call.ttfb_ms),
      },
    },
    {
      key: "ttfr",
      label: "TTFR",
      column: {
        key: "ttfr",
        header: "TTFR",
        render: (call) => milliseconds(call.ttfr_ms),
      },
    },
    {
      key: "ttft",
      label: "TTFT",
      column: {
        key: "ttft",
        header: "TTFT",
        render: (call) => milliseconds(call.ttft_ms),
      },
    },
    {
      key: "input_tokens",
      label: "Input Token",
      column: {
        key: "input_tokens",
        header: "Input Token",
        render: (call) => value(call.input_tokens),
      },
    },
    {
      key: "output_tokens",
      label: "Output Token",
      column: {
        key: "output_tokens",
        header: "Output Token",
        render: (call) => value(call.output_tokens),
      },
    },
    {
      key: "total_tokens",
      label: "Total Token",
      column: {
        key: "total_tokens",
        header: "Total Token",
        render: (call) => value(call.total_tokens),
      },
    },
    {
      key: "cache_read",
      label: "Cache Read",
      column: {
        key: "cache_read",
        header: "Cache Read",
        render: (call) => value(call.cache_read_tokens),
      },
    },
    {
      key: "cache_write",
      label: "Cache Write",
      column: {
        key: "cache_write",
        header: "Cache Write",
        render: (call) => value(call.cache_write_tokens),
      },
    },
    {
      key: "reasoning_tokens",
      label: "Reasoning Token",
      column: {
        key: "reasoning_tokens",
        header: "Reasoning Token",
        render: (call) => value(call.reasoning_tokens),
      },
    },
    {
      key: "message_count",
      label: t("消息数"),
      column: {
        key: "message_count",
        header: t("消息数"),
        render: (call) => call.message_count,
      },
    },
    {
      key: "tool_count",
      label: t("工具数"),
      column: {
        key: "tool_count",
        header: t("工具数"),
        render: (call) => call.tool_count,
      },
    },
    {
      key: "detailed",
      label: t("详细记录"),
      column: {
        key: "detailed",
        header: t("详细记录"),
        render: (call) => (call.detailed ? t("是") : t("否")),
      },
    },
    {
      key: "error_kind",
      label: "Error Kind",
      column: {
        key: "error_kind",
        header: "Error Kind",
        render: (call) => value(call.error_kind),
        title: (call) => call.error_kind ?? undefined,
      },
    },
    {
      key: "error_message",
      label: "Error Message",
      column: {
        key: "error_message",
        header: "Error Message",
        render: (call) => value(call.error_message),
        title: (call) => call.error_message ?? undefined,
      },
    },
    {
      key: "call_id",
      label: "Call ID",
      column: {
        key: "call_id",
        header: "Call ID",
        render: (call) => call.call_id,
        title: (call) => call.call_id,
      },
    },
    {
      key: "run_id",
      label: "Run ID",
      column: {
        key: "run_id",
        header: "Run ID",
        render: (call) => call.run_id,
        title: (call) => call.run_id,
      },
    },
    {
      key: "conversation_id",
      label: "Conversation ID",
      column: {
        key: "conversation_id",
        header: "Conversation ID",
        render: (call) => call.conversation_id,
        title: (call) => call.conversation_id,
      },
    },
    {
      key: "call_index",
      label: "Call Index",
      column: {
        key: "call_index",
        header: "Call Index",
        render: (call) => call.provider_call_index,
      },
    },
  ];
}
