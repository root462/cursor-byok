import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { LlmCall } from "../../shared/api";
import { DataTable } from "../../shared/ui/DataTable";
import type { CallColumnSpec } from "./callColumns";
import { ColumnSettings } from "./ColumnSettings";
import styles from "./CallTable.module.scss";

/** 列宽优先按信息密度设定，未单独配置的扩展列留出可读宽度。 */
const DEFAULT_COLUMN_WIDTH = 148;
const COLUMN_WIDTHS: Record<string, number> = {
  status: 92,
  actions: 52,
  display_name: 150,
  usage_cost: 300,
  created_at: 174,
  model_id: 150,
  reasoning_effort: 100,
  fast: 64,
  call_kind: 118,
  client: 116,
  route: 92,
  duration: 96,
};

export function CallTable({ calls, columns, hidden, onHiddenChange }: {
  calls: LlmCall[];
  columns: CallColumnSpec[];
  hidden: ReadonlySet<string>;
  onHiddenChange?: (next: ReadonlySet<string>) => void;
}) {
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const location = useLocation();

  // 路由或菜单功能切换时自动取消选中，不持久化、不记忆
  useEffect(() => {
    setSelectedCallId(null);
  }, [location.pathname]);

  const handleRowClick = (call: LlmCall) => {
    // 鼠标点击一下标注为整条白色，再点一下取消
    setSelectedCallId((current) => (current === call.call_id ? null : call.call_id));
  };

  const visible = columns.filter((spec) => spec.fixed || !hidden.has(spec.key));
  const tableMinWidth = visible.reduce(
    (width, spec) => width + (COLUMN_WIDTHS[spec.key] ?? DEFAULT_COLUMN_WIDTH),
    0,
  );
  return <DataTable
    rows={calls}
    columns={visible.map((spec) => spec.column)}
    tableClassName={styles.callsTable}
    rowKey={(call) => call.call_id}
    selectedKey={selectedCallId}
    onRowClick={handleRowClick}
    minWidth={Math.max(560, tableMinWidth)}
    footerExtra={onHiddenChange ? <ColumnSettings specs={columns} hidden={hidden} onChange={onHiddenChange} /> : undefined}
  />;
}
