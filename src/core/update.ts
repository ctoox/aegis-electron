/**
 * 自动更新的状态契约 —— 主进程与渲染层共用。
 *
 * 刻意放在 `core/` 而不是 `main/`: `main/updater.ts` 引了 electron,
 * 渲染层一旦（哪怕是 type-only）从那里引类型, 渲染层纯度检查就会红。
 * 这里只有类型, 没有任何 import, 两边都能安全引用。
 */

export type UpdatePhase =
  /** 还没查过 */
  | "idle"
  /** 开发态 / 没有更新源 —— 不是错误, 是"这一版不该查更新" */
  | "unsupported"
  | "checking"
  /** 已是最新 */
  | "uptodate"
  /** 有新版本, 等用户决定要不要下 */
  | "available"
  | "downloading"
  /** 下载完了, 等用户重启以装上 */
  | "ready"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 当前正在运行的版本 —— 界面上应该一直能看到 */
  currentVersion: string;
  /** 新版本号 (available / downloading / ready 时才有) */
  version?: string;
  /** 更新说明。**不要渲染成 HTML** —— 它来自远端 */
  notes?: string;
  /** 下载进度 0~100 */
  percent?: number;
  transferred?: number;
  total?: number;
  /** 为什么不可用 / 出错原因 */
  error?: string;
  /** 最近一次检查完成的时间戳 */
  checkedAt?: number;
}
