/** 共享类型: 主进程 / 渲染层通用 (纯类型, 无运行时代码, 渲染层可安全 import type). */
import type { Snapshot } from "./history";

export type EntryType = "login" | "note" | "bank" | "id";

export interface Entry {
  id: string;
  type: EntryType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  favorite: boolean;
  created_at: number;
  updated_at: number;
  /** 扩展字段: 目前用 totp (Base32 密钥) */
  extra: Record<string, string>;
  /**
   * 历史版本 (旧值快照, 最旧在前). 只在核心字段真的变化时才追加,
   * 随条目一起加密落盘. 由 core/history.ts 维护, 渲染层只读.
   */
  history?: Snapshot[];
}

export type Strength = "good" | "fair" | "weak" | "none";

export interface EntryWithStrength extends Entry {
  strength: Strength;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  hint: string;
}
