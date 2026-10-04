/**
 * 库文件自动滚动备份 (语义对齐 Python 版 `aegis_core/backup.py`).
 *
 * 设计原则:
 *  - 快照 = 库文件**原样拷贝**。库文件本身是密文, 快照天然零知识,
 *    不需要额外加密, 也不会因为备份而多暴露任何明文。
 *  - 每次 save() 成功后调用 backupIfChanged(): 内容与最新快照相同就跳过,
 *    只有真的变了才落新快照 —— 批量保存不会产生一堆一模一样的文件。
 *  - 滚动保留最近 KEEP 份 (默认 10), 超出删最旧。
 *  - **所有异常静默吞掉**: 备份永远不许妨碍主保存。
 *
 * 这是 2026-10-02 空库事故留下的教训 —— 当时用户没有任何自动快照可回退,
 * 只能靠 10-02 10:57 那次手动导出的备份。有了它, 每次落盘前都有兜底。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const BACKUP_SUFFIX = ".bak";
export const DEFAULT_KEEP = 10;

/** 备份目录: 库同目录下的 backups/ 子目录 */
export function backupDirFor(vaultPath: string): string {
  return path.join(path.dirname(vaultPath), "backups");
}

/** 本地时间 YYYYMMDD-HHMMSS (与 Python 的 time.strftime 对齐, 便于人工核对) */
export function localStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 快照文件名: <库名>-<时间戳>.bak<后缀> */
export function snapshotName(vaultPath: string, ts: number): string {
  const ext = path.extname(vaultPath);
  const stem = path.basename(vaultPath, ext);
  return `${stem}-${localStamp(ts)}${BACKUP_SUFFIX}${ext}`;
}

/** 该库的全部快照, 按文件名 (即时间戳) 升序 */
export function listSnapshots(vaultPath: string): string[] {
  const dir = backupDirFor(vaultPath);
  const ext = path.extname(vaultPath);
  const stem = path.basename(vaultPath, ext);
  const prefix = `${stem}-`;
  const suffix = `${BACKUP_SUFFIX}${ext}`;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** 原子写入 (临时文件 + rename): 断电/崩溃时不会留下半截文件 */
export function atomicWriteBytes(dest: string, data: Buffer): void {
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
}

/** 删除超出 keep 的最旧快照, 返回被删掉的列表 */
export function rotate(vaultPath: string, keep = DEFAULT_KEEP): string[] {
  const snaps = listSnapshots(vaultPath);
  const doomed = keep > 0 ? snaps.slice(0, Math.max(0, snaps.length - keep)) : snaps;
  const removed: string[] = [];
  for (const old of doomed) {
    try {
      fs.unlinkSync(old);
      removed.push(old);
    } catch {
      /* 被占用/无权限: 跳过, 下次再清 */
    }
  }
  return removed;
}

/**
 * 库内容与最新快照不同时备份一份, 返回快照路径; 无需备份/失败返回 null。
 *
 * @param keep 滚动保留的快照上限; 0 表示只轮换不保留 (全删)。
 */
export function backupIfChanged(
  vaultPath: string,
  keep = DEFAULT_KEEP,
  now = Date.now(),
): string | null {
  try {
    if (!fs.existsSync(vaultPath)) return null;
    const snaps = listSnapshots(vaultPath);
    const newest = snaps[snaps.length - 1];
    if (newest && fs.readFileSync(newest).equals(fs.readFileSync(vaultPath))) {
      // 内容没变也要保证滚动 (keep 收紧时能借机清理)
      rotate(vaultPath, keep);
      return null;
    }
    return writeSnapshot(vaultPath, keep, now);
  } catch {
    return null; // 备份绝不影响主流程
  }
}

/**
 * 无条件备份一份 (即使内容与最新快照相同)。
 *
 * 破坏性操作 (清空全部 / 改主密码 / 重置) 前必须调它: 那些操作之后
 * `backupIfChanged` 只会留下"操作后"的快照, 而"操作前"的最后状态很可能
 * 早就被滚动淘汰了 —— 强制快照保证一定有一个能退回去的点。
 */
export function backupNow(
  vaultPath: string,
  keep = DEFAULT_KEEP,
  now = Date.now(),
): string | null {
  try {
    if (!fs.existsSync(vaultPath)) return null;
    return writeSnapshot(vaultPath, keep, now);
  } catch {
    return null;
  }
}

/** 落一份快照 + 轮换. 调用方负责保证 vaultPath 存在 */
function writeSnapshot(vaultPath: string, keep: number, now: number): string {
  const dir = backupDirFor(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const data = fs.readFileSync(vaultPath);

  let dest = path.join(dir, snapshotName(vaultPath, now));
  let n = 1;
  // 同一秒内多次变更: 时间戳加秒数递增, 直到找到不冲突的名字
  while (fs.existsSync(dest)) {
    dest = path.join(dir, snapshotName(vaultPath, now + n * 1000));
    n += 1;
  }
  atomicWriteBytes(dest, data);
  rotate(vaultPath, keep);
  return dest;
}

/** 用快照覆盖当前库 (调用方负责先锁掉已解锁的会话) */
export function restoreSnapshot(vaultPath: string, snapshot: string): void {
  const data = fs.readFileSync(snapshot);
  JSON.parse(data.toString("utf8")); // 拒绝非 JSON 的快照
  atomicWriteBytes(vaultPath, data);
}
