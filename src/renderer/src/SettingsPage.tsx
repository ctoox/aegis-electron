import { useEffect, useState } from "react";
import { FORMATS, type FormatId } from "../../core/formats";
import { AUTO_LOCK_CHOICES, CLIP_CLEAR_CHOICES, type Settings } from "../../core/prefs";
import { api, cleanError, type AppInfo } from "./api";
import type { ToastKind } from "./Toast";

type Theme = Settings["theme"];

const THEME_LABEL: Record<Theme, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

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

export function SettingsPage(props: {
  settings: Settings;
  onPatch: (patch: Partial<Settings>) => void;
  notify: (text: string, kind?: ToastKind) => void;
  onImport: () => void;
  onExport: (f: FormatId) => void;
  onBackup: () => void;
  busy: boolean;
}) {
  const { settings, onPatch, notify, onImport, onExport, onBackup, busy } = props;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [exportFormat, setExportFormat] = useState<FormatId>("aegis-json");

  useEffect(() => {
    api.app.info().then(setInfo).catch(() => {});
  }, []);

  async function openDir() {
    try {
      await api.app.openDataDir();
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
        <Row title="数据目录" desc={info?.vaultPath ?? "…"} stack>
          <button className="btn-ghost" onClick={openDir}>
            在文件管理器中打开
          </button>
        </Row>
      </section>

      <section className="scard">
        <h2>ℹ 关于</h2>
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
    </main>
  );
}
