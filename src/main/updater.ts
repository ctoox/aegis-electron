/**
 * 自动更新 —— 包装 `electron-updater`, 把它的回调翻译成一份状态快照。
 *
 * 更新源是 electron-builder 自己产出的元数据 (`latest.yml` 等, 上传进 GitHub
 * Release)。运行时读的是打包进 resources 的 `app-update.yml`, 内容来自
 * `package.json` 的 `build.publish` —— 所以**换发布地址要重新打包**, 改不了运行时。
 *
 * 几个刻意的取舍:
 *
 * - **不自动下载**: 查到新版本只把状态置为 `available`, 下不下由用户点。
 *   密码管理器在用户没同意的时候替换自己的可执行文件, 是越界。
 * - **不自动在退出时装** (`autoInstallOnAppQuit = false`): "我关个软件它自己升级了"
 *   会让人困惑, 而且升级后行为变了却不知道什么时候变的。
 * - **开发态直接 `unsupported`**: `npm run dev` 不该去查线上版本, 更不该因为
 *   查不到而在控制台刷错。
 * - **检查失败只在状态里记一笔**: 断网是常态, 不该弹任何东西。
 */
import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateStatus } from "../core/update";

type Listener = (s: UpdateStatus) => void;

/**
 * 打包时产出的 `app-update.yml` 里写着"去哪查更新"。若打包时 `build.publish`
 * 里的 `${env.GH_OWNER}` / `${env.GH_REPO}` 没被替换掉, 它会原样留在文件里。
 *
 * 这种状态**必须显式认出来**: 否则 electron-updater 的表现是"永远已是最新",
 * 不报错、不留痕, 而你会以为自动更新已经生效了。
 */
function feedConfigured(): boolean {
  if (!app.isPackaged) return false;
  try {
    const yml = readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8");
    return !yml.includes("${env.");
  } catch {
    return false; // 文件不存在 = 打包时根本没配 publish
  }
}

/** releaseNotes 可能是字符串, 也可能是分段数组 —— 统一成一段纯文本 */
function notesText(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes;
  if (!n) return undefined;
  if (typeof n === "string") return n;
  const lines = n
    .map((seg) => (seg.note ? `${seg.version}\n${seg.note}` : seg.version))
    .filter(Boolean);
  return lines.length ? lines.join("\n\n") : undefined;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Updater {
  private readonly listeners = new Set<Listener>();
  private readonly enabled: boolean;
  private status: UpdateStatus;
  private wired = false;

  /** @param supported 只有安装后的版本才该查更新 (打包态) */
  constructor(supported: boolean) {
    const usable = supported && feedConfigured();
    this.enabled = usable;
    this.status = {
      phase: usable ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      error: usable
        ? undefined
        : supported
          ? "这一版没有配置更新源（打包时缺 GH_OWNER / GH_REPO），无法检查更新"
          : "开发模式不检查更新（只有安装后的版本会自动更新）",
    };
    if (usable) this.wire();
  }

  get current(): UpdateStatus {
    return this.status;
  }

  /** 订阅状态变化; 返回取消订阅的函数 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = console;

    autoUpdater.on("checking-for-update", () => {
      this.set({ phase: "checking", error: undefined });
    });

    autoUpdater.on("update-available", (info) => {
      this.set({
        phase: "available",
        version: info.version,
        notes: notesText(info),
        checkedAt: Date.now(),
        error: undefined,
      });
    });

    autoUpdater.on("update-not-available", () => {
      this.set({ phase: "uptodate", version: undefined, checkedAt: Date.now(), error: undefined });
    });

    autoUpdater.on("download-progress", (p) => {
      this.set({
        phase: "downloading",
        percent: Math.round(p.percent * 10) / 10,
        transferred: p.transferred,
        total: p.total,
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.set({ phase: "ready", version: info.version, percent: 100, error: undefined });
    });

    // 未捕获的 error 事件会直接把主进程带崩 —— 必须先接住
    autoUpdater.on("error", (err) => {
      this.set({ phase: "error", error: errText(err), checkedAt: Date.now() });
    });
  }

  /** 查一次。返回查完的状态 (界面"检查更新"按钮直接用返回值即可) */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      // electron-updater 在拿不到 app-update.yml / 网络不通时都会抛
      this.set({ phase: "error", error: errText(e), checkedAt: Date.now() });
    }
    return this.status;
  }

  /** 下载已知的新版本 (只在 phase=available 时有意义) */
  async download(): Promise<UpdateStatus> {
    if (!this.enabled || this.status.phase !== "available") return this.status;
    try {
      this.set({ phase: "downloading", percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.set({ phase: "error", error: errText(e), checkedAt: Date.now() });
    }
    return this.status;
  }

  /** 重启并把已下载的版本装上 (只在 phase=ready 时有意义) */
  install(): boolean {
    if (!this.enabled || this.status.phase !== "ready") return false;
    // 让 IPC 先把响应回给渲染层, 再退出 —— 否则界面拿不到"正在重启"的反馈
    setImmediate(() => {
      autoUpdater.quitAndInstall(/* isSilent */ true, /* isForceRunAfter */ true);
    });
    return true;
  }
}
