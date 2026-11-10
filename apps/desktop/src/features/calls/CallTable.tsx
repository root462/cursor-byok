import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { LlmCall } from "../../shared/api";
import { DataTable } from "../../shared/ui/DataTable";
import type { CallColumnSpec } from "./callColumns";
import { ColumnSettings } from "./ColumnSettings";

/** 全部列都显示时的基准宽度，按可见列数等比缩放表格最小宽度。 */
const FULL_TABLE_MIN_WIDTH = 4180;

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

  const visible = columns.filter((spec) => !hidden.has(spec.key));
  return <DataTable
    rows={calls}
    columns={visible.map((spec) => spec.column)}
    rowKey={(call) => call.call_id}
    selectedKey={selectedCallId}
    onRowClick={handleRowClick}
    minWidth={Math.max(560, Math.round(FULL_TABLE_MIN_WIDTH * visible.length / columns.length))}
    footerExtra={onHiddenChange ? <ColumnSettings specs={columns} hidden={hidden} onChange={onHiddenChange} /> : undefined}
  />;
}
