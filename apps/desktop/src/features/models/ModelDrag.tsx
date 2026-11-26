import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Model } from "../../shared/api";
import { copyModel, modelClients, type ModelClient } from "./modelCopy";
import { useMessage } from "../../shared/ui/message";

type ModelDragState = {
  source: ModelClient | null;
  over: ModelClient | null;
  setSource: (source: ModelClient | null) => void;
  copyTo: (model: Model, target: ModelClient) => Promise<void>;
  copyRevision: Record<ModelClient, number>;
};

const ModelDragContext = createContext<ModelDragState | null>(null);

export function useModelDrag() {
  const drag = useContext(ModelDragContext);
  if (!drag) throw new Error("ModelDragProvider is required");
  return drag;
}

export function modelDropElement(event: Event | undefined) {
  if (!event || event.type.endsWith("cancel")) return null;
  const point = event instanceof MouseEvent ? event
    : event instanceof TouchEvent ? event.changedTouches[0] : undefined;
  return point ? document.elementFromPoint(point.clientX, point.clientY) : null;
}

export function modelDropTarget(element: Element | null): ModelClient | null {
  const client = element?.closest<HTMLElement>("[data-model-client]")?.dataset.modelClient;
  return client === "cursor" || client === "claude" || client === "codex" ? client : null;
}

export function ModelDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<ModelClient | null>(null);
  const [over, setOver] = useState<ModelClient | null>(null);
  const [copyRevision, setCopyRevision] = useState({ cursor: 0, claude: 0, codex: 0 });
  const copying = useRef(new Set<ModelClient>());
  const message = useMessage();

  useEffect(() => {
    if (!source) return;
    const track = (event: Event) => setOver(modelDropTarget(modelDropElement(event)));
    document.addEventListener("pointermove", track);
    document.addEventListener("touchmove", track, { passive: true });
    return () => {
      document.removeEventListener("pointermove", track);
      document.removeEventListener("touchmove", track);
    };
  }, [source]);

  const copyTo = useCallback(async (model: Model, target: ModelClient) => {
    if (copying.current.has(target)) {
      message(t("处理中…"));
      return;
    }
    copying.current.add(target);
    const name = modelClients[target];
    try {
      const result = await copyModel(model, target);
      if (result === "exists") message(t("{name} 已有模型 {model}", { name, model: model.display_name }));
      if (result === "copied") {
        setCopyRevision((current) => ({ ...current, [target]: current[target] + 1 }));
        message(t("已将模型 {model} 复制到 {name}", { model: model.display_name, name }));
      }
    } catch (cause) {
      message(t("复制到 {name} 失败：{error}", { name, error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      copying.current.delete(target);
    }
  }, [message]);

  const setDragSource = useCallback((client: ModelClient | null) => {
    setSource(client);
    setOver(null);
  }, []);

  return <ModelDragContext.Provider value={{ source, over, setSource: setDragSource, copyTo, copyRevision }}>
    {children}
  </ModelDragContext.Provider>;
}
