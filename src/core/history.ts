/**
 * 条目历史版本 —— 旧值快照, 存在 `entry.history` 里, 随条目一起加密.
 *
 * 与 Python 版 `aegis_core/history.py` 语义对齐:
 *   - 每次 update() 前, 若**核心字段**确有变化, 就把旧值全量快照 push 进历史
 *   - 最多保留 KEEP 条 (默认 20), 超出丢最旧
 *   - 恢复 = 把某快照的字段写回条目; 恢复动作本身也会被 update() 记成新快照,
 *     所以"恢复错了"可以再恢复回来, 不会丢数据
 *
 * 为什么不记 favorite / extra: 收藏、TOTP 密钥这类改动频繁且没有"回过味来"的
 * 需求, 记进去只会把真正的密码变更挤出保留窗口.
 */
import type { Entry } from "./types";

export const SNAPSHOT_FIELDS = ["title", "username", "password", "url", "notes"] as const;
export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

export const FIELD_LABELS: Record<SnapshotField, string> = {
  title: "标题",
  username: "用户名",
  password: "密码",
  url: "网址",
  notes: "备注",
};

/** 每个条目保留多少条历史. 20 条约 30 次编辑的窗口, 足够"改错了回一步" */
export const DEFAULT_KEEP = 20;

export interface Snapshot {
  /** 快照产生时间 (被覆盖的那一刻, 不是更新时间) */
  at: number;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

/** 条目当前值中"会被记历史"的那几个字段 */
export function snapshotOf(e: Entry): Omit<Snapshot, "at"> {
  return {
    title: e.title ?? "",
    username: e.username ?? "",
    password: e.password ?? "",
    url: e.url ?? "",
    notes: e.notes ?? "",
  };
}

/** 快照与条目当前值相比, 核心字段是否有差异 */
export function coreChanged(snap: Partial<Snapshot>, e: Entry): boolean {
  const cur = snapshotOf(e);
  return SNAPSHOT_FIELDS.some((k) => (snap[k] ?? "") !== cur[k]);
}

/** 读某条目的历史 (最旧在前). 容错: 字段缺失/类型不对都当空历史 */
export function listHistory(e: Entry): Snapshot[] {
  return Array.isArray(e.history) ? e.history : [];
}

/** 把旧值快照追加进条目历史, 超出 keep 丢最旧 */
export function pushHistory(
  e: Entry,
  old: Omit<Snapshot, "at">,
  keep = DEFAULT_KEEP,
): void {
  e.history = [...listHistory(e), { ...old, at: Date.now() }].slice(-keep);
}

/** 该快照与条目当前值相比, 有差异的字段中文名 (用于列表摘要) */
export function diffSummary(snap: Snapshot, e: Entry): string[] {
  const cur = snapshotOf(e);
  return SNAPSHOT_FIELDS.filter((k) => (snap[k] ?? "") !== cur[k]).map(
    (k) => FIELD_LABELS[k],
  );
}

/**
 * 把第 index 条快照的字段取出来 (越界返回 null).
 *
 * 只返回 patch 而不直接改条目 —— 调用方应该把它交给 `VaultStore.update()`,
 * 这样"恢复"这个动作本身也会被记进历史, 恢复错了还能再恢复回来.
 */
export function snapshotPatch(e: Entry, index: number): Partial<Entry> | null {
  const hist = listHistory(e);
  if (!Number.isInteger(index) || index < 0 || index >= hist.length) return null;
  const snap = hist[index];
  return {
    title: snap.title ?? "",
    username: snap.username ?? "",
    password: snap.password ?? "",
    url: snap.url ?? "",
    notes: snap.notes ?? "",
  };
}
