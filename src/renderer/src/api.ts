/** 渲染层 API 封装: 类型化 + 主进程错误消息清洗. */
import type { Entry, EntryWithStrength, VaultStatus } from "../../core/types";
import type { HealthReport } from "../../core/health";
import type { FormatId, FormatInfo } from "../../core/formats";
import type { ImportPreview } from "../../core/portable";
import type { Settings } from "../../core/prefs";

export type { HealthReport, FormatId, FormatInfo, ImportPreview, Settings };

export interface ImportCandidate extends ImportPreview {
  fileName: string;
  filePath: string;
  bytes: number;
}

export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  os: string;
  material: "vibrancy" | "acrylic" | "mica" | "inapp";
  kdf: { algo: string; memoryKiB: number; iterations: number; parallelism: number };
  vaultPath: string;
  settingsPath: string;
}

declare global {
  interface Window {
    api: {
      greet: (name: string) => Promise<string>;
      win: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<void>;
        close: () => Promise<void>;
      };
      vault: {
        status: () => Promise<VaultStatus>;
        create: (password: string, hint: string) => Promise<VaultStatus>;
        unlock: (password: string) => Promise<VaultStatus>;
        lock: () => Promise<VaultStatus>;
        list: () => Promise<EntryWithStrength[]>;
        add: (partial: Partial<Entry>) => Promise<Entry>;
        update: (id: string, patch: Partial<Entry>) => Promise<Entry>;
        remove: (id: string) => Promise<boolean>;
        exportBackup: () => Promise<{ path: string; count: number } | null>;
      };
      pw: {
        generate: (opts: {
          length: number;
          useUpper: boolean;
          useLower: boolean;
          useDigits: boolean;
          useSymbols: boolean;
          minDigits: number;
          minSymbols: number;
        }) => Promise<string>;
        passphrase: () => Promise<string>;
      };
      totp: {
        code: (secret: string) => Promise<{
          code: string;
          remaining: number;
          period: number;
          error?: string;
        }>;
      };
      app: {
        platform: () => Promise<string>;
        material: () => Promise<{
          material: "vibrancy" | "acrylic" | "mica" | "inapp";
          platform: string;
          native: boolean;
        }>;
        info: () => Promise<AppInfo>;
        openDataDir: () => Promise<void>;
        activity: () => Promise<number>;
        onLocked: (cb: (reason: string) => void) => () => void;
        onClipboardCleared: (cb: () => void) => () => void;
      };
      clip: {
        copy: (text: string) => Promise<{ clearIn: number }>;
        clear: () => Promise<boolean>;
      };
      health: {
        report: (deep: boolean) => Promise<HealthReport>;
      };
      portable: {
        formats: () => Promise<FormatInfo[]>;
        pickImport: () => Promise<ImportCandidate | null>;
        commitImport: (
          entries: Entry[],
          opts: { skipDuplicates?: boolean },
        ) => Promise<{ added: number; skipped: number }>;
        export: (
          format: FormatId,
        ) => Promise<{ path: string; count: number; label: string; format: FormatId } | null>;
      };
      settings: {
        get: () => Promise<Settings>;
        set: (patch: Partial<Settings>) => Promise<Settings>;
      };
    };
  }
}

export const api = window.api;

/** ipcRenderer.invoke 的报错带长前缀, 只留我们自己的中文消息 */
export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Error: (.+)$/);
  return m ? m[1] : msg;
}
