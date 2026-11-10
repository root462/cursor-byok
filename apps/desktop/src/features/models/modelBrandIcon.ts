import type { IconifyIcon } from "@iconify/react/offline";
import deepseekIcon from "../../shared/assets/provider-icons/deepseek.svg";
import geminiIcon from "../../shared/assets/provider-icons/gemini.svg";
import grokIcon from "../../shared/assets/provider-icons/grok.svg";
import huoshanIcon from "../../shared/assets/provider-icons/huoshan.png";
import kimiIcon from "../../shared/assets/provider-icons/kimi.svg";
import minimaxIcon from "../../shared/assets/provider-icons/minimax.svg";
import qwenIcon from "../../shared/assets/provider-icons/qwen.svg";
import zhipuIcon from "../../shared/assets/provider-icons/zhipu.svg";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";

export interface ModelBrandIcon {
  src?: string;
  icon?: IconifyIcon;
  name: string;
}

export function resolveModelBrandIcon(model: {
  display_name?: string;
  model_id?: string;
  base_url?: string;
  group_name?: string | null;
  type?: string;
}): ModelBrandIcon {
  const text = `${model.model_id ?? ""} ${model.display_name ?? ""} ${model.group_name ?? ""} ${model.base_url ?? ""}`.toLowerCase();

  // 1. DeepSeek
  if (text.includes("deepseek") || text.includes("deep-seek") || text.includes("deep_seek")) {
    return { src: deepseekIcon, name: "DeepSeek" };
  }

  // 2. OpenAI / GPT / o1 / o3 / o4 / ChatGPT
  if (/\b(gpt|o1|o3|o4|chatgpt|openai|dall-e|text-embedding)\b/i.test(text) || text.includes("openai.com")) {
    return { icon: openAiIcon, name: "OpenAI" };
  }

  // 3. Claude / Anthropic
  if (text.includes("claude") || text.includes("anthropic")) {
    return { icon: claudeIcon, name: "Claude" };
  }

  // 4. Gemini / Google
  if (text.includes("gemini") || text.includes("antigravity") || text.includes("generativelanguage") || text.includes("google")) {
    return { src: geminiIcon, name: "Gemini" };
  }

  // 5. Kimi / Moonshot
  if (text.includes("kimi") || text.includes("moonshot")) {
    return { src: kimiIcon, name: "Kimi" };
  }

  // 6. Zhipu / GLM / BigModel
  if (text.includes("glm") || text.includes("zhipu") || text.includes("bigmodel")) {
    return { src: zhipuIcon, name: "GLM" };
  }

  // 7. Volcano / Ark / Doubao / 字节火山
  if (text.includes("ark") || text.includes("doubao") || text.includes("volces") || text.includes("volcengine") || text.includes("huoshan")) {
    return { src: huoshanIcon, name: "Volcengine" };
  }

  // 8. Qwen / 通义千问 / DashScope
  if (text.includes("qwen") || text.includes("tongyi") || text.includes("dashscope")) {
    return { src: qwenIcon, name: "Qwen" };
  }

  // 9. MiniMax
  if (text.includes("minimax")) {
    return { src: minimaxIcon, name: "MiniMax" };
  }

  // 10. Grok / xAI
  if (text.includes("grok") || text.includes("x.ai") || text.includes("xai")) {
    return { src: grokIcon, name: "Grok" };
  }

  // 默认兜底按请求协议
  if (model.type === "anthropic") {
    return { icon: claudeIcon, name: "Anthropic" };
  }
  return { icon: openAiIcon, name: "OpenAI" };
}
