import { autoUpdate, computePosition, flip, offset, shift, size, type VirtualElement } from "@floating-ui/dom";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Tooltip.module.scss";

export type TooltipAnchor = VirtualElement;

type TooltipContextValue = {
  show: (anchor: TooltipAnchor, id: string | undefined, content: ReactNode) => void;
  hide: () => void;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

export function useTooltip() {
  const context = useContext(TooltipContext);
  if (!context) throw new Error("useTooltip must be used within TooltipProvider");
  return context;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ anchor: TooltipAnchor; id?: string; content: ReactNode } | null>(null);
  const hideTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const clearHide = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const context = useMemo(() => ({
    show: (anchor: TooltipAnchor, id: string | undefined, content: ReactNode) => {
      clearHide();
      setActive({ anchor, id, content });
    },
    hide: () => {
      clearHide();
      hideTimer.current = window.setTimeout(() => {
        setActive(null);
        hideTimer.current = null;
      }, 150);
    },
  }), []);

  return <TooltipContext.Provider value={context}>
    {children}
    <Tooltip
      id={active?.id}
      anchor={active?.anchor ?? null}
      onPointerEnter={clearHide}
      onPointerLeave={context.hide}
    >{active?.content}</Tooltip>
  </TooltipContext.Provider>;
}

export function Tooltip({ id, anchor, children, onPointerEnter, onPointerLeave }: {
  id?: string;
  anchor: TooltipAnchor | null;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; availableHeight: number } | null>(null);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) {
      setPosition(null);
      return;
    }

    setPosition(null);
    let active = true;
    const updatePosition = () => {
      let availableHeight = 0;
      void computePosition(anchor, tooltip, {
        strategy: "fixed",
        placement: "top",
        middleware: [
          offset(8),
          flip({ padding: 12 }),
          shift({ padding: 12 }),
          size({
            padding: 12,
            apply({ availableHeight: nextAvailableHeight }) {
              availableHeight = nextAvailableHeight;
            },
          }),
        ],
      }).then(({ x, y }) => {
        if (!active) return;
        setPosition((current) =>
          current?.left === x && current.top === y && current.availableHeight === availableHeight
            ? current
            : { left: x, top: y, availableHeight },
        );
      });
    };

    const cleanup = autoUpdate(anchor, tooltip, updatePosition);
    return () => {
      active = false;
      cleanup();
    };
  }, [anchor]);

  if (!anchor) return null;

  // Tooltip overlays always live under body, outside the trigger's layout and stacking context.
  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className={styles.root}
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxHeight: position ? Math.max(0, position.availableHeight) : undefined,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className={styles.body}>{children}</div>
    </div>,
    document.body,
  );
}
