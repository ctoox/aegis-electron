/** 共享类型: 主进程 / 渲染层通用 (纯类型, 无运行时代码, 渲染层可安全 import type). */
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
