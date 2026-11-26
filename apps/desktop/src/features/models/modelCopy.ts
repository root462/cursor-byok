import { api, type Model, type ModelInput } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";

export const modelClients = {
  cursor: "Cursor",
  claude: "Claude CLI",
  codex: "Codex Desktop",
} as const;

export type ModelClient = keyof typeof modelClients;

export function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

export async function copyModel(model: Model, target: ModelClient): Promise<"copied" | "exists" | "failed"> {
  const models = await (target === "cursor" ? api.models() : api.clientModels(target));
  if (models.some((item) => item.model_hash === model.model_hash)) return "exists";

  const sort_order = models.reduce((last, item) => Math.max(last, item.sort_order), 0) + 1;
  const input = [{ ...modelInput(model), sort_order }];
  const created = await (target === "cursor" ? appStore.createModels(input) : api.createClientModels(target, input));
  return created?.length ? "copied" : "failed";
}
