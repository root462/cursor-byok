/**
 * 调用表格的列显隐偏好。
 *
 * 存的是「被隐藏的列」而不是「可见的列」，因此以后 columns 里新增的列会自动可见，
 * 不会被旧偏好挡住。从未设置过时回落到各列的 defaultHidden 默认值；
 * 用户一旦设置过（哪怕是把所有列都打开，写成 `[]`），就完全以用户的选择为准。
 */

const STORAGE_KEY = "cursor-byok.calls.hidden-columns";

export function loadHiddenColumns(fallback: ReadonlySet<string>): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    return fallback;
  }
}

export function saveHiddenColumns(hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
  } catch {
    // 存储不可用（隐私模式/配额满）时保留内存态即可，不影响表格本身。
  }
}
