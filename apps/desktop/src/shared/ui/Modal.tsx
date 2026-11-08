import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ScrollableContent } from "../virtual/ScrollableContent";
import controls from "./Controls.module.scss";
import styles from "./Modal.module.scss";

type ModalProps = {
  id?: string;
  open: boolean;
  title: string;
  children: ReactNode;
  banner?: ReactNode;
  busy?: boolean;
  wide?: boolean;
  compact?: boolean;
  fullHeight?: boolean;
  role?: "dialog" | "alertdialog";
  ariaDescribedBy?: string;
  initialFocus?: "first" | "submit";
  onClose: () => void;
  onSubmit?: () => void;
  secondaryAction?: ReactNode;
  closeLabel?: string;
  submitLabel?: string;
  submitDisabled?: boolean;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => element.getClientRects().length > 0);
}

/** 与 Modal.module.scss 里 oa-dialog-out 的时长保持一致。 */
const CLOSE_ANIMATION_MS = 170;

export function Modal({ id, open, title, children, banner, busy, wide, compact, fullHeight, role = "dialog", ariaDescribedBy, initialFocus = "first", onClose, onSubmit, secondaryAction, closeLabel = t("取消"), submitLabel = t("保存"), submitDisabled = false }: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(Boolean(busy));
  const titleId = useId();
  closeRef.current = onClose;
  busyRef.current = Boolean(busy);
  // open 由父组件持有，置 false 时不能立刻卸载，否则退场动画根本没机会播。
  // 这里多留 render 一层：open=false 先切到 closing 播退场，播完再真正卸载。
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
      return;
    }
    if (!render) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setRender(false);
      setClosing(false);
    }, CLOSE_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open, render]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented || !dialog.current) return;
      const focusable = focusableElements(dialog.current);
      if (!focusable.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const focusFrame = requestAnimationFrame(() => {
      const currentDialog = dialog.current;
      if (!currentDialog) return;
      const target = initialFocus === "submit" ? submitButton.current : focusableElements(currentDialog)[0];
      (target ?? currentDialog).focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [initialFocus, open]);
  if (!render) return null;
  return createPortal(<div className={styles.mask} data-state={closing ? "closing" : "open"}>
    <div className={styles.dragLayer} data-tauri-drag-region aria-hidden="true" />
    <div id={id} ref={dialog} className={[styles.dialog, wide && styles.wide, compact && styles.compact, fullHeight && styles.fullHeight].filter(Boolean).join(" ")} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={ariaDescribedBy} tabIndex={-1}>
      <header id={titleId}>{title}</header>
      {banner && <div className={styles.banner}>{banner}</div>}
      <ScrollableContent alwaysShowVertical className={styles.body} contentClassName={styles.bodyContent}>{children}</ScrollableContent>
      <footer>
        <button type="button" className={controls.primary} disabled={busy} onClick={onClose}>{closeLabel}</button>
        {secondaryAction}
        {onSubmit && <button ref={submitButton} type="button" className={controls.primary} disabled={busy || submitDisabled} onClick={onSubmit}>{busy ? t("处理中…") : submitLabel}</button>}
      </footer>
    </div>
  </div>, document.body);
}
