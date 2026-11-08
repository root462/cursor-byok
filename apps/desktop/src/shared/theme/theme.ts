// 应用只提供亮色主题：液态玻璃是为浅色底图设计的。深色分支已移除，
// isThemeId 会拒绝历史存下的 "default-dark"，自动回落到亮色。
export const themeIds = ["default-light"] as const;
export type ThemeId = (typeof themeIds)[number];

export const themeOptions = [
  { id: "default-light" },
] satisfies { id: ThemeId }[];

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && themeIds.some((id) => id === value);
}

export function applyTheme(themeId: ThemeId) {
  document.documentElement.dataset.theme = themeId;
}
