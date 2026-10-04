/**
 * 密码库存储: 文件格式与 VaultStore.
 *
 * 文件格式:
 * {
 *   version, format: "aegis-vault",
 *   header: { kdf: {...}, kdf_salt, dek_nonce, wrapped_dek, hint },
 *   entries: [ { id, type, updated_at, nonce, data } ]  // data = 密文
 * }
 * 加密在内存完成, 落盘不含任何明文; lock() 后密钥全部清引用.
 *
 * 注意: 这个 header 布局是本实现自己的 (扁平 kdf_salt / dek_nonce / wrapped_dek),
 * 与 Python 版的「slots 数组」布局**不互通** —— 两边的库文件不能直接互开。
 * 要迁移数据请走 portable.ts 的导入导出 (明文 JSON/CSV) 或 share.ts 的分享包。
 */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import path from "node:path";
import {
  decryptEntry,
  deriveKek,
  encryptEntry,
  KDF_PARAMS,
  newDek,
  unwrapDek,
  wrapDek,
} from "./crypto";
import {
  atomicWriteBytes,
  backupIfChanged,
  backupNow,
  localStamp,
} from "./backup";
import {
  coreChanged,
  pushHistory,
  snapshotOf,
  snapshotPatch,
} from "./history";
import type { Entry, EntryType } from "./types";

export type { Entry, EntryType };

export function newEntry(partial: Partial<Entry> = {}): Entry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: "login",
    title: "",
    username: "",
    password: "",
    url: "",
    notes: "",
    favorite: false,
    created_at: now,
    updated_at: now,
    extra: {},
    ...partial,
  };
}

const FORMAT = "aegis-vault";
const VERSION = 1;

/** 重置主密码时旧库的备份路径: <库文件名>.<时间戳>.bak (与库同目录) */
export function resetBackupPath(filePath: string, now = Date.now()): string {
  return `${filePath}.${localStamp(now)}.bak`;
}

export class VaultStore {
  private dek: Buffer | null = null;
  private entries = new Map<string, Entry>();

  private constructor(
    public readonly filePath: string,
    private header: any,
    // 注意: KEK 只在构造时用于解包 DEK, 不保留在实例上 —— 内存里只留 DEK
    _kek: Buffer,
  ) {}

  get unlocked(): boolean {
    return this.dek !== null;
  }
  get hint(): string {
    return String(this.header?.hint ?? "");
  }

  /** 新建库: 写入文件并返回已解锁实例 */
  static async create(
    filePath: string,
    masterPassword: string,
    hint = "",
  ): Promise<VaultStore> {
    if (masterPassword.length < 8) {
      throw new Error("主密码至少 8 位");
    }
    const salt = crypto.randomBytes(16);
    const kek = await deriveKek(masterPassword, salt);
    const dek = newDek();
    const { nonce, wrapped } = wrapDek(dek, kek);
    const header = {
      kdf: { ...KDF_PARAMS },
      kdf_salt: salt.toString("base64"),
      dek_nonce: nonce.toString("base64"),
      wrapped_dek: wrapped.toString("base64"),
      hint,
    };
    const doc = { version: VERSION, format: FORMAT, header, entries: [] };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteBytes(filePath, Buffer.from(JSON.stringify(doc, null, 2), "utf8"));
    const store = new VaultStore(filePath, header, kek);
    store.dek = dek;
    return store;
  }

  /**
   * 打开已有库: 主密码错 → GCM 认证失败 → 抛 "主密码错误" */
  static async open(filePath: string, masterPassword: string): Promise<VaultStore> {
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (doc.format !== FORMAT) throw new Error("不是有效的神盾密码库文件");
    const h = doc.header;
    const kek = await deriveKek(
      masterPassword,
      Buffer.from(h.kdf_salt, "base64"),
    );
    let dek: Buffer;
    try {
      dek = unwrapDek(
        Buffer.from(h.wrapped_dek, "base64"),
        Buffer.from(h.dek_nonce, "base64"),
        kek,
      );
    } catch {
      throw new Error("主密码错误");
    }
    const store = new VaultStore(filePath, h, kek);
    store.dek = dek;
    for (const rec of doc.entries ?? []) {
      const aad = `${rec.id}|${rec.type}`;
      const entry = decryptEntry(rec.nonce, rec.data, dek, aad) as Entry;
      store.entries.set(entry.id, entry);
    }
    return store;
  }

  /**
   * 重置主密码 —— **忘记旧密码时唯一的出路**。
   *
   * 零知识加密下没有后门: DEK 由主密码派生的 KEK 包裹, 旧密码丢失即 DEK
   * 不可恢复, 原条目密文永远解不开。所以本函数不会 (也无法) 保留旧条目:
   *
   *   1. (可选) 把旧库文件另存为 `<名>.<时间戳>.bak`, 万一想起旧密码还能回去;
   *   2. 用新主密码生成全新的 salt + KEK + DEK, 覆盖写入原路径;
   *   3. 新库是空的, 需要重新录入或从备份/导入恢复。
   *
   * 还记得旧密码、只是要换 → 请用 changePassword(), 那个不动密文。
   */
  static async reset(
    filePath: string,
    newPassword: string,
    hint = "",
    keepBackup = true,
  ): Promise<{ store: VaultStore; backupPath: string | null }> {
    if (newPassword.length < 8) {
      throw new Error("新主密码至少 8 位");
    }
    let backupPath: string | null = null;
    if (keepBackup && fs.existsSync(filePath)) {
      backupPath = resetBackupPath(filePath);
      fs.copyFileSync(filePath, backupPath);
    }
    const store = await VaultStore.create(filePath, newPassword, hint);
    return { store, backupPath };
  }

  /** 锁定: 清空内存密钥与明文条目 */
  lock(): void {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
    this.entries.clear();
  }

  private assertUnlocked(): Buffer {
    if (!this.dek) throw new Error("密码库未解锁");
    return this.dek;
  }

  list(): Entry[] {
    this.assertUnlocked();
    return [...this.entries.values()].sort((a, b) => b.updated_at - a.updated_at);
  }

  get(id: string): Entry | null {
    this.assertUnlocked();
    return this.entries.get(id) ?? null;
  }

  add(partial: Partial<Entry>): Entry {
    const e = newEntry(partial);
    this.assertUnlocked();
    this.entries.set(e.id, e);
    this.save();
    return e;
  }

  /**
   * 批量新增 (导入用). 逐条 add() 每次都会重写整个文件并重新加密全部条目,
   * 500 条就是 O(n²) → 这里只在最后 save() 一次.
   */
  addMany(partials: Partial<Entry>[]): Entry[] {
    this.assertUnlocked();
    const created = partials.map((p) => newEntry(p));
    for (const e of created) this.entries.set(e.id, e);
    if (created.length > 0) this.save();
    return created;
  }

  /**
   * 更新条目. 核心字段 (标题/用户名/密码/网址/备注) 确有变化时,
   * 先把**旧值**快照进 entry.history, 再写入新值 —— 这样"改完发现改错了"
   * 总是能退回去.
   *
   * patch 里的 history 字段会被忽略: 历史由本类维护, 渲染层的往返
   * (列表里取出来带 history, 编辑后回传) 不能把历史冲掉.
   */
  update(id: string, patch: Partial<Entry>): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error("条目不存在");
    this.assertUnlocked();
    const before = snapshotOf(e);
    const { history: _ignored, ...rest } = patch as Entry;
    Object.assign(e, rest, { id: e.id, updated_at: Date.now() });
    if (coreChanged(before, e)) pushHistory(e, before);
    this.save();
    return e;
  }

  /** 把第 index 条历史快照写回条目 (恢复动作本身也会进历史, 可再撤销) */
  restoreHistory(id: string, index: number): Entry {
    this.assertUnlocked();
    const e = this.entries.get(id);
    if (!e) throw new Error("条目不存在");
    const patch = snapshotPatch(e, index);
    if (!patch) throw new Error("历史版本不存在");
    return this.update(id, patch);
  }

  remove(id: string): boolean {
    this.assertUnlocked();
    const ok = this.entries.delete(id);
    if (ok) this.save();
    return ok;
  }

  /**
   * 批量删除 (列表多选 / 健康页一键清理用). 与 addMany 同理:
   * 逐条 remove() 每次都重写整个文件并重新加密全部条目 → O(n²),
   * 这里只在最后 save() 一次. 返回**真正删掉**的条数 (不存在的 id 不计).
   */
  removeMany(ids: string[]): number {
    this.assertUnlocked();
    let removed = 0;
    for (const id of ids) {
      if (this.entries.delete(id)) removed++;
    }
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * 清空全部条目 —— 保留主密码与库文件本身 (与 reset() 的区别:
   * reset 连主密码一起换掉)。返回清掉的条数。
   *
   * 动手前强制落一份"清空前"的快照, 所以这一步永远可逆 —— 退路见
   * 设置页「数据 → 恢复快照」或 backups/ 目录里的 .bak。
   */
  clearAll(): number {
    this.assertUnlocked();
    const n = this.entries.size;
    if (n === 0) return 0;
    backupNow(this.filePath);
    this.entries.clear();
    this.save();
    return n;
  }

  /**
   * 二次校验主密码 (批量删除等敏感操作的防误触).
   *
   * 注意这不是"比对内存里存的密码" —— KEK 在构造时就丢掉了, 内存里只有 DEK.
   * 这里用同一份 header 里的 salt 重新派生一次 KEK, 再试解包 wrapped_dek:
   * 解包成功即密码正确 (GCM 认证失败就说明是错的). 最后再比对派生出的 DEK
   * 与内存中的 DEK 是否一致 —— 防的是 header 被掉包的情况.
   *
   * 代价: 一次完整 Argon2id (64MiB/t3), 本机约 0.3~0.5s, 所以调用方要显示忙碌态.
   */
  async verifyMasterPassword(password: string): Promise<boolean> {
    this.assertUnlocked();
    return this.checkPassword(password);
  }

  /**
   * 修改主密码 —— 还记得旧密码、只是想换一个。
   *
   * 与 reset() 的本质区别: reset 换的是**整把钥匙** (新 DEK, 旧密文全废);
   * 这里只换包裹 DEK 的那层壳 —— 校验旧密码后, 用新的 salt 派生新 KEK,
   * 把**同一个 DEK** 重新包一遍。所有条目密文一条都不用动, 数据零损失。
   */
  async changePassword(
    oldPassword: string,
    newPassword: string,
    hint = "",
  ): Promise<void> {
    const dek = this.assertUnlocked();
    if (newPassword.length < 8) throw new Error("新主密码至少 8 位");
    if (newPassword === oldPassword) throw new Error("新主密码与当前主密码相同");
    if (!(await this.checkPassword(oldPassword))) {
      throw new Error("当前主密码不正确");
    }

    // 强制留一份"换密码前"的快照: 换完发现不对还能退回去
    backupNow(this.filePath);

    const salt = crypto.randomBytes(16);
    const kek = await deriveKek(newPassword, salt);
    const { nonce, wrapped } = wrapDek(dek, kek);
    kek.fill(0);

    this.header = {
      kdf: { ...KDF_PARAMS },
      kdf_salt: salt.toString("base64"),
      dek_nonce: nonce.toString("base64"),
      wrapped_dek: wrapped.toString("base64"),
      hint,
    };
    this.save();
  }

  /**
   * 主密码是否匹配. 用 header 里的 salt 重新派生 KEK 并试解包 wrapped_dek,
   * 再与内存 DEK 比对 —— 后者防的是 header 被掉包的情况.
   */
  private async checkPassword(password: string): Promise<boolean> {
    const dek = this.assertUnlocked();
    // 空密码不必走 Argon2 —— 顺带避开 hash-wasm「Password must be specified」
    if (!password) return false;
    const h = this.header;
    let kek: Buffer | null = null;
    try {
      kek = await deriveKek(password, Buffer.from(h.kdf_salt, "base64"));
      const got = unwrapDek(
        Buffer.from(h.wrapped_dek, "base64"),
        Buffer.from(h.dek_nonce, "base64"),
        kek,
      );
      const same = got.equals(dek);
      got.fill(0);
      return same;
    } catch {
      // 派生失败 / GCM 认证失败 都等同于"密码不对", 不向渲染层抛内部错误
      return false;
    } finally {
      kek?.fill(0);
    }
  }

  private save(): void {
    const dek = this.assertUnlocked();
    const doc = {
      version: VERSION,
      format: FORMAT,
      header: this.header,
      entries: this.list().map((e) => ({
        id: e.id,
        type: e.type,
        updated_at: e.updated_at,
        ...encryptEntry(e, dek, `${e.id}|${e.type}`),
      })),
    };
    // 原子写: 崩在中途也不会留下半截 JSON 把库彻底搞坏
    atomicWriteBytes(this.filePath, Buffer.from(JSON.stringify(doc, null, 2), "utf8"));
    // 自动滚动备份 (内容变了才落, 保留最近 10 份; 失败静默, 绝不影响主保存)
    backupIfChanged(this.filePath);
  }
}
