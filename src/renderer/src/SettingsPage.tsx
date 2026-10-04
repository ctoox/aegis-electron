import { useEffect, useState } from "react";
import { FORMATS, type FormatId } from "../../core/formats";
import { AUTO_LOCK_CHOICES, CLIP_CLEAR_CHOICES, type Settings } from "../../core/prefs";
import {
  api,
  cleanError,
  type AppInfo,
  type BackupSnapshot,
  type UpdateStatus,
} from "./api";
import { ChangePasswordModal, ClearAllModal } from "./Security";
import type { ToastKind } from "./Toast";

type Theme = Settings["theme"];

const THEME_LABEL: Record<Theme, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

/** 把更新状态翻成一句人话 —— 界面上只暴露这一个函数, 免得各处各写一套 */
function updateText(s: UpdateStatus | null): string {
  if (!s) return "尚未查询";
  switch (s.phase) {
    case "idle":
      return "尚未查询";
    case "unsupported":
      return s.error ?? "当前版本不检查更新";
    case "checking":
      return "正在检查…";
    case "uptodate":
      return `已是最新版本（${s.currentVersion}）`;
    case "available":
      return `发现新版本 ${s.version}（当前 ${s.currentVersion}）`;
    case "downloading":
      return `正在下载 ${s.version ?? ""}… ${s.percent?.toFixed(0) ?? 0}%`;
    case "ready":
      return `新版本 ${s.version} 已下载，重启后生效`;
    case "error":
      return `检查更新失败：${s.error ?? "未知原因"}`;
  }
}

/**
 * 更新只有一个按钮, 它的含义随状态走。
 * 拆成三个按钮(检查/下载/重启)会让其中两个长期处于"点了没用"的灰态,
 * 不如让按钮自己变成当前唯一该做的那件事。
 */
function updateActionLabel(s: UpdateStatus | null): string {
  switch (s?.phase) {
    case "ready":
      return "重启并安装";
    case "available":
      return "下载新版本";
    case "downloading":
      return `下载中 ${s.percent?.toFixed(0) ?? 0}%`;
    case "checking":
      return "检查中…";
    default:
      return "检查更新";
  }
}

function updateActionStep(s: UpdateStatus | null): "check" | "download" | "install" {
  if (s?.phase === "ready") return "install";
  if (s?.phase === "available") return "download";
  return "check";
}

function Row(props: { title: string; desc?: string; children: React.ReactNode; stack?: boolean }) {
  return (
    <div className={`srow ${props.stack ? "stack" : ""}`}>
      <div className="srow-txt">
        <div className="t">{props.title}</div>
        {props.desc && <div className="s">{props.desc}</div>}
      </div>
      <div className="srow-ctl">{props.children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <i />
    </button>
  );
}

function sizeText(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function timeText(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

export function SettingsPage(props: {
  settings: Settings;
  onPatch: (patch: Partial<Settings>) => void;
  notify: (text: string, kind?: ToastKind) => void;
  onImport: () => void;
  onExport: (f: FormatId) => void;
  onBackup: () => void;
  onShareExport: () => void;
  onShareImport: () => void;
  /** 库内容被本页改动了 (清空 / 恢复快照) → 让上层刷新条目列表 */
  onChanged: () => void;
  busy: boolean;
}) {
  const {
    settings, onPatch, notify, onImport, onExport, onBackup,
    onShareExport, onShareImport, onChanged, busy,
  } = props;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [exportFormat, setExportFormat] = useState<FormatId>("aegis-json");
  const [snaps, setSnaps] = useState<BackupSnapshot[]>([]);
  const [count, setCount] = useState(0);
  /** 当前密码提示语 —— 供「修改主密码」弹窗预填, 避免用户在不知情下把提示清空 */
  const [hint, setHint] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [upd, setUpd] = useState<UpdateStatus | null>(null);
  const [updBusy, setUpdBusy] = useState(false);

  useEffect(() => {
    api.app.info().then(setInfo).catch(() => {});
    api.backup.list().then(setSnaps).catch(() => setSnaps([]));
    api.vault.list().then((l) => setCount(l.length)).catch(() => {});
    api.vault.status().then((s) => setHint(s.hint)).catch(() => {});
    // 先拉一次当前快照, 之后靠主进程推 —— 只拉不推会漏掉"后台检查发现新版本"
    api.update.status().then(setUpd).catch(() => {});
    return api.update.onStatus(setUpd);
  }, []);

  async function runUpdate(step: "check" | "download" | "install") {
    setUpdBusy(true);
    try {
      if (step === "install") {
        await api.update.install();
        return; // 马上就重启了, 不用再更新状态
      }
      const s = await api.update[step]();
      if (s) setUpd(s);
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setUpdBusy(false);
    }
  }

  async function openDir() {
    try {
      await api.app.openDataDir();
    } catch (e) {
      notify(cleanError(e), "err");
    }
  }

  async function openBackupDir() {
    try {
      await api.backup.openDir();
    } catch (e) {
      notify(cleanError(e), "err");
    }
  }

  /**
   * 从快照恢复。这不只是"复制个文件" —— 它会打断当前会话, 恢复后必须用
   * 快照当时的密码重新解锁, 所以确认文案要把这件事说清楚。
   */
  async function restoreSnap(s: BackupSnapshot) {
    const ok = confirm(
      `用快照「${s.name}」覆盖当前密码库？\n\n` +
        `· 当前状态会先被另存为一份新快照，所以这一步本身也可以撤回；\n` +
        `· 恢复完成后密码库会锁定，需要用**该快照当时的密码**解锁。`,
    );
    if (!ok) return;
    try {
      await api.backup.restore(s.path);
      notify("已从快照恢复。请用该快照当时的密码解锁。", "warn");
    } catch (e) {
      notify(cleanError(e), "err");
    }
  }

  const importable = FORMATS.filter((f) => f.dir !== "out");
  const exportable = FORMATS.filter((f) => f.dir !== "in");

  return (
    <main className="page settings-page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p className="page-sub">
            设置存在 <code>aegis.settings.json</code>（明文，不含任何密钥），与密码库文件分离，换库不影响偏好
          </p>
        </div>
      </header>

      <section className="scard">
        <h2>🔒 安全</h2>
        <Row title="闲置自动锁定" desc="超过该时长没有任何操作就自动锁库；0 表示关闭">
          <select
            className="sselect"
            value={settings.autoLockMinutes}
            onChange={(e) => onPatch({ autoLockMinutes: Number(e.target.value) })}
          >
            {AUTO_LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "不自动锁定" : `${m} 分钟`}
              </option>
            ))}
          </select>
        </Row>
        <Row title="窗口失焦时立即锁定" desc="切到别的应用就锁，最安全但最烦人">
          <Toggle on={settings.lockOnBlur} onChange={(v) => onPatch({ lockOnBlur: v })} />
        </Row>
        <Row title="剪贴板自动清空" desc="复制密码后倒计时清空；若期间你又复制了别的内容，则不会去动它">
          <select
            className="sselect"
            value={settings.clipboardClearSeconds}
            onChange={(e) => onPatch({ clipboardClearSeconds: Number(e.target.value) })}
          >
            {CLIP_CLEAR_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "不清空" : `${s} 秒`}
              </option>
            ))}
          </select>
        </Row>
        <Row title="锁定后清空剪贴板" desc="锁库时顺手把剪贴板也清掉">
          <Toggle on={settings.clearClipboardOnLock} onChange={(v) => onPatch({ clearClipboardOnLock: v })} />
        </Row>
        <Row title="泄露检测（HIBP）" desc="健康检查联调用；查询只发送密码 SHA-1 的前 5 位，k-匿名，不发送密码本身">
          <Toggle on={settings.hibpEnabled} onChange={(v) => onPatch({ hibpEnabled: v })} />
        </Row>
        <Row
          title="修改主密码"
          desc="还记得旧密码、只是想换一个。条目密文一条都不动，数据零损失"
          stack
        >
          <button className="btn-ghost" onClick={() => setPwOpen(true)}>
            修改主密码…
          </button>
        </Row>
      </section>

      <section className="scard">
        <h2>🪄 生成器默认值</h2>
        <Row title="默认长度" desc={`${settings.genLength} 位`}>
          <input
            type="range"
            min={6}
            max={64}
            value={settings.genLength}
            onChange={(e) => onPatch({ genLength: Number(e.target.value) })}
          />
        </Row>
        <Row title="字符集">
          <div className="chipgroup">
            {(
              [
                ["genUseLower", "小写"],
                ["genUseUpper", "大写"],
                ["genUseDigits", "数字"],
                ["genUseSymbols", "符号"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`cbtn ${settings[k] ? "on" : ""}`}
                onClick={() => onPatch({ [k]: !settings[k] } as Partial<Settings>)}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row title="最少数字位数">
          <input
            type="number"
            className="snum"
            min={0}
            max={20}
            value={settings.genMinDigits}
            onChange={(e) => onPatch({ genMinDigits: Number(e.target.value) })}
          />
        </Row>
        <Row title="最少符号位数">
          <input
            type="number"
            className="snum"
            min={0}
            max={20}
            value={settings.genMinSymbols}
            onChange={(e) => onPatch({ genMinSymbols: Number(e.target.value) })}
          />
        </Row>
      </section>

      <section className="scard">
        <h2>🎨 外观</h2>
        <Row title="主题">
          <div className="chipgroup">
            {(["light", "dark", "system"] as Theme[]).map((t) => (
              <button
                key={t}
                className={`cbtn ${settings.theme === t ? "on" : ""}`}
                onClick={() => onPatch({ theme: t })}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        </Row>
        <Row
          title="玻璃效果"
          desc={
            info
              ? info.material === "inapp"
                ? "当前系统没有可用的窗口模糊 API，使用页内 backdrop-filter；老机器上关掉可以省性能"
                : `当前使用系统材质：${info.material}`
              : "…"
          }
        >
          <Toggle on={settings.glass} onChange={(v) => onPatch({ glass: v })} />
        </Row>
        <Row
          title="关闭窗口时最小化到托盘"
          desc="关掉后点 × 就退出应用；打开后只是收进系统托盘，点托盘图标能叫回来（退出走托盘右键菜单）"
        >
          <Toggle
            on={settings.closeToTray}
            onChange={(v) => onPatch({ closeToTray: v })}
          />
        </Row>
      </section>

      <section className="scard">
        <h2>📦 数据</h2>
        <Row
          title="导入"
          desc={`支持 ${importable.map((f) => f.label).join(" / ")}`}
          stack
        >
          <button className="btn-ghost" disabled={busy} onClick={onImport}>
            选择文件并预览…
          </button>
        </Row>
        <Row title="导出" desc="以下格式全部是明文，请导出后妥善保管并及时删除" stack>
          <div className="export-row">
            <select
              className="sselect grow"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as FormatId)}
            >
              {exportable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}（.{f.ext}）
                </option>
              ))}
            </select>
            <button className="gen-btn" disabled={busy} onClick={() => onExport(exportFormat)}>
              导出…
            </button>
          </div>
        </Row>
        <Row title="备份加密库文件" desc="直接复制 aegis.vault.json，仍是密文，可原样放回数据目录恢复" stack>
          <button className="btn-ghost" disabled={busy} onClick={onBackup}>
            备份为密文副本…
          </button>
        </Row>

        <div className="sec-divider">
          <b>加密分享包</b>
          <span>
            把选中的条目打包成<b>密文</b>文件，用独立口令保护。接收方拿到口令才能解开，
            拿不到你的主密码，也看不到没被选中的条目。与上面的明文导出完全不同。
          </span>
        </div>
        <Row title="导出分享包" desc="选中若干条目后导出（没勾选就是整个库）" stack>
          <button className="btn-ghost" disabled={busy} onClick={onShareExport}>
            导出加密分享包…
          </button>
        </Row>
        <Row title="导入分享包" desc="先给明文元信息预览，确认是我要的那个包再输口令" stack>
          <button className="btn-ghost" disabled={busy} onClick={onShareImport}>
            选择分享包…
          </button>
        </Row>

        <div className="sec-divider">
          <b>库文件快照</b>
          <span>
            每次写盘都会把改动前的库文件留一份在备份目录（本身就是密文），滚动保留最近 10 份。
            这是误操作、断电、崩溃之后最直接的退路。
          </span>
        </div>
        <Row
          title={`自动快照（${snaps.length} 份）`}
          desc={
            snaps.length
              ? "新的在前。恢复会用该快照覆盖当前库，并锁定密码库"
              : "还没有快照 —— 有写入之后才会产生"
          }
          stack
        >
          {snaps.length === 0 ? (
            <button className="btn-ghost" onClick={openBackupDir}>
              打开备份目录
            </button>
          ) : (
            <ul className="snap-list">
              {snaps.map((s) => (
                <li key={s.path}>
                  <span className="snap-name">{s.name}</span>
                  <span className="snap-meta">
                    {timeText(s.mtime)} · {sizeText(s.bytes)}
                  </span>
                  <button className="snap-act" onClick={() => restoreSnap(s)}>
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Row>

        <Row title="数据目录" desc={info?.vaultPath ?? "…"} stack>
          <button className="btn-ghost" onClick={openDir}>
            在文件管理器中打开
          </button>
        </Row>

        <div className="sec-divider danger">
          <b>危险操作</b>
          <span>
            清空只移除条目，主密码不变，且清空前会自动留一份快照（可退回来）。
            若连主密码也不记得了，请到解锁页用「忘记主密码 → 重置」。
          </span>
        </div>
        <Row title={`清空全部条目（当前 ${count} 条）`} desc="需要输入主密码确认" stack>
          <button
            className="btn-danger"
            disabled={busy || count === 0}
            onClick={() => setClearOpen(true)}
          >
            清空全部密码…
          </button>
        </Row>
      </section>

      <section className="scard">
        <h2>ℹ 关于</h2>
        <Row title="软件更新" desc={updateText(upd)} stack>
          <button
            className="btn-ghost"
            disabled={
              updBusy || upd?.phase === "downloading" || upd?.phase === "unsupported"
            }
            onClick={() => void runUpdate(updateActionStep(upd))}
          >
            {updateActionLabel(upd)}
          </button>
        </Row>
        {info ? (
          <div className="about-grid">
            <div><span>应用版本</span><b>{info.appVersion}</b></div>
            <div><span>Electron</span><b>{info.electron}</b></div>
            <div><span>Chromium</span><b>{info.chrome}</b></div>
            <div><span>Node</span><b>{info.node}</b></div>
            <div><span>系统</span><b>{info.os}</b></div>
            <div><span>窗口材质</span><b>{info.material}</b></div>
            <div><span>KDF（只读）</span><b>{info.kdf.algo}</b></div>
            <div><span>内存 / 迭代 / 并行</span><b>{info.kdf.memoryKiB} KiB · t={info.kdf.iterations} · p={info.kdf.parallelism}</b></div>
            <div className="wide"><span>加密方案</span><b>Argon2id → KEK(32B) → 包裹随机 DEK → AES-256-GCM 信封，AAD = entryId|type</b></div>
          </div>
        ) : (
          <p className="muted">读取中…</p>
        )}
      </section>

      {pwOpen && (
        <ChangePasswordModal
          currentHint={hint}
          onClose={() => setPwOpen(false)}
          onDone={(msg) => {
            setPwOpen(false);
            // 提示可能刚被改过, 重读一次: 再开弹窗时预填的才是新值
            api.vault.status().then((s) => setHint(s.hint)).catch(() => {});
            notify(msg, "ok");
          }}
        />
      )}

      {clearOpen && (
        <ClearAllModal
          count={count}
          onClose={() => setClearOpen(false)}
          onDone={(removed) => {
            setClearOpen(false);
            setCount(0);
            notify(
              `已清空 ${removed} 个条目（清空前的快照已留在备份目录，需要时可在上方恢复）`,
              "ok",
            );
            // 快照列表多了一份"清空前"的; 上层也要刷新条目列表
            api.backup.list().then(setSnaps).catch(() => {});
            onChanged();
          }}
        />
      )}
    </main>
  );
}
