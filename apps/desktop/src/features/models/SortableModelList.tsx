import { useEffect, useRef, type ReactNode } from "react";
import Sortable, { type SortableEvent } from "sortablejs";
import type { Model } from "../../shared/api";
import { modelDropElement, modelDropTarget, useModelDrag } from "./ModelDrag";
import type { ModelClient } from "./modelCopy";
import styles from "./CursorSettings.module.scss";

type SortableModelListProps = {
  client: ModelClient;
  models: Model[];
  disabled: boolean;
  className: string;
  itemClassName: string;
  onReorder?: (hashes: string[]) => void;
  children: ReactNode;
};

export function SortableModelList({ client, models, disabled, className, itemClassName, onReorder, children }: SortableModelListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const latest = useRef({ models, disabled, onReorder });
  latest.current = { models, disabled, onReorder };
  const { setSource, copyTo } = useModelDrag();
  const canReorder = Boolean(onReorder);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let dragging = false;
    const sortable = Sortable.create(list, {
      sort: canReorder,
      disabled: latest.current.disabled,
      animation: 160,
      dataIdAttr: "data-model-hash",
      draggable: `.${itemClassName}`,
      filter: "button, a, input, select, textarea, [data-prevent-drag]",
      preventOnFilter: false,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onStart: () => {
        dragging = true;
        setSource(client);
      },
      onEnd: (event: SortableEvent & { originalEvent?: Event }) => {
        dragging = false;
        setSource(null);
        const { models, disabled, onReorder } = latest.current;
        const order = models.map((model) => model.model_hash);
        const reordered = canReorder ? sortable.toArray() : order;
        const changed = reordered.some((hash, index) => hash !== order[index]);
        // Sortable moves DOM nodes during drag. Restore React's order before applying any action.
        if (changed) sortable.sort(order, false);
        if (disabled) return;

        const element = modelDropElement(event.originalEvent);
        const target = modelDropTarget(element);
        if (target && target !== client) {
          const model = models.find(({ model_hash }) => model_hash === event.item.dataset.modelHash);
          if (model) void copyTo(model, target);
        } else if (changed && element && list.contains(element)) {
          onReorder?.(reordered);
        }
      },
    });
    sortableRef.current = sortable;
    return () => {
      if (dragging) setSource(null);
      sortable.destroy();
      sortableRef.current = null;
    };
  }, [canReorder, client, copyTo, itemClassName, setSource]);

  useEffect(() => {
    sortableRef.current?.option("disabled", disabled);
  }, [disabled]);

  return <div ref={listRef} className={className}>{children}</div>;
}
