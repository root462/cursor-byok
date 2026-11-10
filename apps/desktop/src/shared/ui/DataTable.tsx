import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollableContent } from "../virtual/ScrollableContent";
import { Pagination } from "./Pagination";
import styles from "./DataTable.module.scss";

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  title?: (row: T) => string | undefined;
  className?: string;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  minWidth,
  emptyText = t("暂无数据"),
  footerExtra,
  selectedKey,
  onRowClick,
}: {
  rows: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string | number;
  minWidth?: number | string;
  emptyText?: ReactNode;
  footerExtra?: ReactNode;
  selectedKey?: string | number | null;
  onRowClick?: (row: T) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const pageRows = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [page, pageSize, rows]);

  return <div className={styles.root}>
    <div className={styles.tableRegion}>
      <ScrollableContent
        horizontal
        className={[styles.viewport, rows.length === 0 ? styles.emptyViewport : ""].filter(Boolean).join(" ")}
        viewportClassName={styles.tableViewport}
        contentClassName={styles.tableContent}
        scrollbarInsetTop="33px"
      >
        <table className={styles.table} style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.className}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const key = rowKey(row);
              const isSelected = selectedKey != null && selectedKey === key;
              return (
                <tr
                  key={key}
                  className={[
                    onRowClick ? styles.clickableRow : "",
                    isSelected ? styles.selectedRow : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={column.className}
                      title={column.title?.(row)}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollableContent>
      {rows.length === 0 && <div className={styles.emptyState}>{emptyText}</div>}
    </div>
    <Pagination
      extra={footerExtra}
      page={page}
      pageCount={pageCount}
      pageSize={pageSize}
      total={rows.length}
      onPageChange={setPage}
      onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }}
    />
  </div>;
}
