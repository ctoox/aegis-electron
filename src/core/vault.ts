/**
 * 密码库存储: 文件格式与 VaultStore.
 *
 * 文件格式 (与 Python 版 "aegis-vault" 同构, 便于日后互导入):
 * {
 *   version, format: "aegis-vault",
 *   header: { kdf: {...}, kdf_salt, dek_nonce, wrapped_dek, hint },
 *   entries: [ { id, type, updated_at, nonce, data } ]  // data = 密文
 * }
 * 加密在内存完成, 落盘不含任何明文; lock() 后密钥全部清引用.
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
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), "utf8");
    const store = new VaultStore(filePath, header, kek);
    store.dek = dek;
    return store;
  }

  /** 打开已有库: 主密码错 → GCM 认证失败 → 抛 "主密码错误" */
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

  update(id: string, patch: Partial<Entry>): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error("条目不存在");
    Object.assign(e, patch, { id: e.id, updated_at: Date.now() });
    this.save();
    return e;
  }

  remove(id: string): boolean {
    this.assertUnlocked();
    const ok = this.entries.delete(id);
    if (ok) this.save();
    return ok;
  }

  private save(): void {
    const dek = this.assertUnlocked();
    const doc = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    doc.entries = this.list().map((e) => ({
      id: e.id,
      type: e.type,
      updated_at: e.updated_at,
      ...encryptEntry(e, dek, `${e.id}|${e.type}`),
    }));
    fs.writeFileSync(this.filePath, JSON.stringify(doc, null, 2), "utf8");
  }
}
