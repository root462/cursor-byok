import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon } from "../../shared/ui/icons";
import type { CallColumnSpec } from "./callColumns";
import styles from "./ColumnSettings.module.scss";

/** 调用表格下方的列显隐面板。勾选变化即时生效，由调用方负责持久化。 */
export function ColumnSettings({ specs, hidden, onChange }: {
  specs: CallColumnSpec[];
  hidden: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    return autoUpdate(trigger.current, menu.current, () =>
      void computePosition(trigger.current!, menu.current!, {
        placement: "top-start",
        middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 })],
      }).then(({ x, y }) => setPosition({ left: x, top: y })));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const visibleCount = specs.filter((spec) => spec.fixed || !hidden.has(spec.key)).length;
  const toggle = (key: string, visible: boolean) => {
    const draft = new Set(hidden);
    if (visible) draft.delete(key);
    else draft.add(key);
    onChange(draft);
  };

  return <>
    <Button
      ref={trigger}
      size="small"
      className={styles.trigger}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
    >
      {t("列设置")}
      <Icon icon={chevronDownIcon} size="1em" className={open ? styles.openIcon : undefined} />
    </Button>
    {open && createPortal(
      <div
        ref={menu}
        className={styles.menu}
        role="dialog"
        aria-label={t("选择要显示的列")}
        style={{ left: position.left, top: position.top }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      >
        <div className={styles.header}>
          <span>{t("显示的列")}</span>
          <span className={styles.count}>{visibleCount} / {specs.length}</span>
        </div>
        <div className={styles.list}>
          {specs.map((spec) => (
            <div key={spec.key} className={styles.item}>
              <Checkbox
                checked={spec.fixed || !hidden.has(spec.key)}
                disabled={spec.fixed}
                label={spec.label}
                onChange={(visible) => toggle(spec.key, visible)}
              />
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.reset}
            disabled={hidden.size === 0}
            onClick={() => onChange(new Set())}
          >
            {t("全部显示")}
          </button>
        </div>
      </div>,
      document.body,
    )}
  </>;
}
