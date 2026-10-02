/**
 * 设置的**磁盘读写**层（Node 专用）。
 *
 * 与密码库文件分离 —— 设置里不含任何密钥，换库不影响偏好。
 * 结构与校验在 ./prefs.ts（纯 TS，渲染层可安全 import），本文件只做 I/O，
 * 并把 prefs 的导出原样转出，保持 `import ... from "./settings"` 的老调用点可用。
 *
 * 读取永远不抛错：文件缺失 / 损坏 / 字段非法时逐项回退到默认值。
 */
import * as fs from "node:fs";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  settingsPath,
  type Settings,
} from "./prefs";

export * from "./prefs";

/** 读取设置；文件不存在或损坏都返回默认值 */
export function loadSettings(userDataDir: string): Settings {
  try {
    const p = settingsPath(userDataDir);
    if (!fs.existsSync(p)) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 合并并落盘，返回合并后的完整设置。
 * 写盘失败（只读目录等）不阻断运行，只返回合并结果。
 */
export function saveSettings(userDataDir: string, patch: Partial<Settings>): Settings {
  const merged = normalizeSettings({ ...loadSettings(userDataDir), ...(patch ?? {}) });
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(merged, null, 2), "utf8");
  } catch {
    /* 忽略写盘失败 */
  }
  return merged;
}
