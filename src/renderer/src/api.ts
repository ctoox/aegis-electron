/** 渲染层 API 封装: 类型化 + 主进程错误消息清洗. */
import type { Entry, EntryWithStrength, VaultStatus } from "../../core/types";

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
