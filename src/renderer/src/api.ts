/** 渲染层 API 封装: 类型化 + 主进程错误消息清洗. */
import type { Entry, EntryWithStrength, VaultStatus } from "../../core/types";
import type { HealthReport } from "../../core/health";
import type { FormatId, FormatInfo } from "../../core/formats";
import type { ImportPreview } from "../../core/portable";
import type { Settings } from "../../core/prefs";
import type { Snapshot } from "../../core/history";
import type { BundleInfo, ShareBundle } from "../../core/share";
import type { UpdateStatus } from "../../core/update";

export type {
  HealthReport,
  FormatId,
  FormatInfo,
  ImportPreview,
  Settings,
  Snapshot,
  BundleInfo,
  ShareBundle,
  UpdateStatus,
};

export interface ImportCandidate extends ImportPreview {
  fileName: string;
  filePath: string;
  bytes: number;
}

export interface ShareCandidate {
  info: BundleInfo;
  fileName: string;
  bytes: number;
  /** 原始分享包 (原样回传给主进程解密, 渲染层看不到任何条目明文) */
  doc: ShareBundle;
}

export interface BackupSnapshot {
  path: string;
  name: string;
  bytes: number;
  mtime: number;
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
        removeMany: (ids: string[]) => Promise<number>;
        verify: (password: string) => Promise<boolean>;
        exportBackup: () => Promise<{ path: string; count: number } | null>;
        /** 改主密码: 只重包 DEK, 条目密文一条不动 */
        changePassword: (
          oldPassword: string,
          newPassword: string,
          hint: string,
        ) => Promise<VaultStatus>;
        /** 重置: 忘记旧密码时的出路, 旧库留 .bak, 新库为空 */
        reset: (
          newPassword: string,
          hint: string,
          keepBackup: boolean,
        ) => Promise<VaultStatus & { backupPath: string | null }>;
        /** 清空全部条目 (需二次校验主密码); 返回清掉的条数 */
        clearAll: (password: string) => Promise<number>;
        history: (id: string) => Promise<Snapshot[]>;
        restoreHistory: (id: string, index: number) => Promise<Entry>;
      };
      backup: {
        list: () => Promise<BackupSnapshot[]>;
        restore: (snapPath: string) => Promise<VaultStatus>;
        openDir: () => Promise<void>;
      };
      share: {
        export: (
          ids: string[],
          opts: {
            password: string;
            title?: string;
            sender?: string;
            note?: string;
            hint?: string;
          },
        ) => Promise<{ path: string; count: number; fingerprint: string } | null>;
        pickImport: () => Promise<ShareCandidate | null>;
        commitImport: (
          doc: unknown,
          password: string,
          opts: { forceNewIds?: boolean },
        ) => Promise<{
          added: number;
          skipped: number;
          rekeyed: number;
          title: string;
          sender: string;
        }>;
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
      update: {
        status: () => Promise<UpdateStatus | null>;
        check: () => Promise<UpdateStatus | null>;
        download: () => Promise<UpdateStatus | null>;
        install: () => Promise<boolean>;
        onStatus: (cb: (status: UpdateStatus) => void) => () => void;
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
