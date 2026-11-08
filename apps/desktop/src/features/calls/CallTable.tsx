import type { LlmCall } from "../../shared/api";
import { DataTable } from "../../shared/ui/DataTable";
import type { CallColumnSpec } from "./callColumns";

/** 全部列都显示时的基准宽度，按可见列数等比缩放表格最小宽度。 */
const FULL_TABLE_MIN_WIDTH = 4180;

export function CallTable({ calls, columns, hidden }: {
  calls: LlmCall[];
  columns: CallColumnSpec[];
  hidden: ReadonlySet<string>;
}) {
  const visible = columns.filter((spec) => !hidden.has(spec.key));
  return <DataTable
    rows={calls}
    columns={visible.map((spec) => spec.column)}
    rowKey={(call) => call.call_id}
    minWidth={Math.max(560, Math.round(FULL_TABLE_MIN_WIDTH * visible.length / columns.length))}
  />;
}
