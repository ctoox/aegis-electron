import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { analyzeLocal } from "../../core/health";
import { FORMATS, type FormatId } from "../../core/formats";
import { DEFAULT_SETTINGS, type Settings } from "../../core/prefs";
import { api, cleanError, type ImportCandidate } from "./api";
import { ColoredPassword } from "./ColoredPassword";
import { CommandPalette } from "./CommandPalette";
import { EntryModal } from "./EntryModal";
import { Gate } from "./Gate";
import { GeneratorModal } from "./GeneratorModal";
import { HealthPage } from "./HealthPage";
import { ImportPreviewModal } from "./ImportExport";
import { SettingsPage } from "./SettingsPage";
import { Toasts, useToasts } from "./Toast";
import { TotpCard } from "./TotpCard";

type GateMode = "loading" | "create" | "unlock" | "ready";
type Theme = Settings["theme"];
type Material = "vibrancy" | "acrylic" | "mica" | "inapp";
type View = "vault" | "health" | "settings";

const MATERIAL_LABEL: Record<Material, string> = {
  vibrancy: "系统毛玻璃",
  acrylic: "亚克力",
  mica: "云母",
  inapp: "页内玻璃",
};

const AVATAR_COLORS = [
  "#5E9CE6", "#7A6FE0", "#E07A5F", "#2FA356",
  "#E09B3C", "#4CB9B1", "#D96BA0", "#6B8FD9",
];

const STRENGTH_LABEL = {
  good: { text: "强度 · 强", cls: "good" },
  fair: { text: "强度 · 一般", cls: "warn" },
  weak: { text: "强度 · 弱", cls: "bad" },
  none: { text: "未设置密码", cls: "bad" },
} as const;

function avatarColor(e: EntryWithStrength) {
  let h = 0;
  for (const c of e.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function timeStr(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 设置 → 生成器默认参数 (字段与 GenOptions 同名同义, 全部给值) */
function genDefaultsOf(s: Settings) {
  return {
    length: s.genLength,
    useUpper: s.genUseUpper,
    useLower: s.genUseLower,
    useDigits: s.genUseDigits,
    useSymbols: s.genUseSymbols,
    minDigits: s.genMinDigits,
    minSymbols: s.genMinSymbols,
  };
}

export default function App() {
  const [gate, setGate] = useState<GateMode>("loading");
  const [hint, setHint] = useState("");
  const [entries, setEntries] = useState<EntryWithStrength[]>([]);
  const [cat, setCat] = useState<"all" | "fav">("all");
  const [view, setView] = useState<View>("vault");
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [modal, setModal] = useState<
    | { kind: "entry"; entry: EntryWithStrength | null }
    | { kind: "gen" }
    | null
  >(null);
  const [backend, setBackend] = useState("后端连接中…");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("aegis.theme") as Theme) || "system",
  );
  const [isMac, setIsMac] = useState(false);
  const [material, setMaterial] = useState<Material>("inapp");
  // 玻璃效果开关: 低端机上 backdrop-filter 有代价, 允许关掉
  const [glassOn, setGlassOn] = useState(
    () => localStorage.getItem("aegis.glass") !== "off",
  );
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const { items: toasts, notify } = useToasts();

  // ---- 启动: 平台 / 材质 / 设置 ----
  useEffect(() => {
    api.app.platform().then((p) => setIsMac(p === "darwin"));
    api.app
      .material()
      .then((m) => setMaterial(m.material))
      .catch(() => setMaterial("inapp"));
    api.settings
      .get()
      .then((s) => {
        setSettings(s);
        // 设置文件是权威来源; localStorage 只是为了首屏不闪
        setTheme(s.theme);
        setGlassOn(s.glass);
      })
      .catch(() => {});
  }, []);

  // 玻璃材质挂到 <html>: data-glass 控制开关, data-mat 记录材质来源
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.glass = glassOn ? "on" : "off";
    root.dataset.mat = material;
  }, [material, glassOn]);

  useEffect(() => {
    localStorage.setItem("aegis.glass", glassOn ? "on" : "off");
  }, [glassOn]);

  // 主题: 跟随系统时用媒体查询, 手动时打 data-theme
  useEffect(() => {
    localStorage.setItem("aegis.theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /** 改设置: 本地立即生效 + 落盘 (主进程会 clamp 校验) */
  const patchSettings = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings((s) => ({ ...s, ...patch }));
      if (patch.theme !== undefined) setTheme(patch.theme);
      if (patch.glass !== undefined) setGlassOn(patch.glass);
      try {
        setSettings(await api.settings.set(patch));
      } catch (e) {
        notify(cleanError(e), "err");
      }
    },
    [notify],
  );

  function cycleTheme() {
    patchSettings({ theme: theme === "light" ? "dark" : theme === "dark" ? "system" : "light" });
  }

  // 全局快捷键: Ctrl/Cmd+K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (gate === "ready") setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate]);

  async function refresh(keepSel?: string) {
    const list = await api.vault.list();
    setEntries(list);
    setSelId((cur) => {
      const want = keepSel ?? cur;
      return want && list.some((e) => e.id === want) ? want : (list[0]?.id ?? null);
    });
  }

  useEffect(() => {
    api.vault
      .status()
      .then((s) => {
        if (s.unlocked) {
          setGate("ready");
          refresh();
        } else {
          setHint(s.hint);
          setGate(s.exists ? "unlock" : "create");
        }
      })
      .catch(() => setGate("create"));
    api
      .greet("神盾")
      .then((m) => setBackend(m))
      .catch((e) => setBackend(`后端未连通: ${e}`));
  }, []);

  // ---- 活动心跳: 渲染层节流上报, 主进程据此做自动锁定倒计时 ----
  useEffect(() => {
    if (gate !== "ready") return;
    let last = 0;
    const ping = () => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      api.app.activity().catch(() => {});
    };
    const evs = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;
    for (const e of evs) window.addEventListener(e, ping, { passive: true });
    ping();
    return () => {
      for (const e of evs) window.removeEventListener(e, ping);
    };
  }, [gate]);

  // ---- 主进程锁库 (闲置超时 / 失焦 / 手动) 的统一出口 ----
  useEffect(() => {
    return api.app.onLocked((reason) => {
      setEntries([]);
      setSelId(null);
      setCmdOpen(false);
      setModal(null);
      setCandidate(null);
      setView("vault");
      setGate("unlock");
      if (reason === "idle") notify("闲置超时，密码库已自动锁定", "warn");
      else if (reason === "blur") notify("窗口失去焦点，密码库已锁定", "warn");
    });
  }, [notify]);

  // ---- 剪贴板被定时清空 ----
  useEffect(() => {
    return api.app.onClipboardCleared(() => notify("剪贴板已自动清空", "info"));
  }, [notify]);

  async function onGateDone() {
    setGate("ready");
    setView("vault");
    await refresh();
  }

  async function toggleFav(e: EntryWithStrength) {
    await api.vault.update(e.id, { favorite: !e.favorite });
    await refresh(e.id);
  }

  async function genPassword(e: EntryWithStrength) {
    const pw = await api.pw.generate({ ...genDefaultsOf(settings) });
    await api.vault.update(e.id, { password: pw });
    await refresh(e.id);
    setShowPw(true);
    notify("已生成并保存新密码", "ok");
  }

  async function removeEntry(e: EntryWithStrength) {
    if (!confirm(`确定删除「${e.title}」吗？此操作不可撤销。`)) return;
    await api.vault.remove(e.id);
    await refresh();
  }

  /** 复制统一走主进程: 才能做「按设置定时清空」+「内容被改动就不清」 */
  async function copyText(t: string, label = "已复制") {
    if (!t) return;
    try {
      const r = await api.clip.copy(t);
      notify(r.clearIn > 0 ? `${label}，${r.clearIn} 秒后自动清空剪贴板` : label, "ok");
    } catch (e) {
      notify(cleanError(e), "err");
    }
  }

  async function lockVault() {
    await api.vault.lock();
    // onLocked 回调里已经清了界面状态, 这里只兜底
    setEntries([]);
    setSelId(null);
    setCmdOpen(false);
    setGate("unlock");
    setView("vault");
  }

  // ---- 导入 / 导出 ----
  async function doImport() {
    setBusy(true);
    try {
      const c = await api.portable.pickImport();
      if (c) setCandidate(c);
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function doExport(f: FormatId) {
    const info = FORMATS.find((x) => x.id === f);
    if (
      info?.plaintext &&
      !confirm(
        `「${info.label}」是明文格式 —— 导出的文件任何人拿到都能直接看到全部密码。\n\n` +
          `建议导出后尽快导入到目标工具并删除该文件。确定现在导出吗？`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await api.portable.export(f);
      if (r) notify(`已导出 ${r.count} 条到 ${r.path}`, "ok");
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function doBackup() {
    setBusy(true);
    try {
      const r = await api.vault.exportBackup();
      if (r) notify(`已备份密文副本（${r.count} 条）到 ${r.path}`, "ok");
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(false);
    }
  }

  function onPaletteAction(id: string) {
    if (id === "new") setModal({ kind: "entry", entry: null });
    else if (id === "theme") cycleTheme();
    else if (id === "lock") lockVault();
    else if (id === "settings") setView("settings");
    else if (id === "health") setView("health");
    else if (id === "import") doImport();
    else if (id === "generate") setModal({ kind: "gen" });
    else if (id === "generate-copy") {
      api.pw
        .generate({ ...genDefaultsOf(settings) })
        .then((pw) => copyText(pw, "已生成并复制"));
    }
  }

  const themeLabel =
    theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";

  const visible = useMemo(() => {
    let list = entries;
    if (cat === "fav") list = list.filter((e) => e.favorite);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (x) =>
          x.title.toLowerCase().includes(q) ||
          x.username.toLowerCase().includes(q),
      );
    }
    return list;
  }, [entries, cat, query]);

  const sel = entries.find((e) => e.id === selId) ?? null;
  // 侧栏健康分 = 本地体检 (不联网, 秒出)
  const localHealth = useMemo(() => analyzeLocal(entries), [entries]);
  const problems =
    localHealth.weak + localHealth.reusedEntries + localHealth.http + localHealth.no2fa;

  const customFields = sel
    ? Object.entries(sel.extra ?? {}).filter(([k]) => k.startsWith("field:"))
    : [];

  return (
    <div className="shell">
      {/* ===== 自绘标题栏 (macOS 用系统红黄绿圆点, 仅留拖拽区) ===== */}
      <div className={`titlebar ${isMac ? "mac" : ""}`} data-tauri-drag-region>
        <div className="tb-title" data-tauri-drag-region>
          🛡️ 神盾 Aegis
          {gate !== "ready"
            ? ""
            : view === "vault"
              ? ` — ${entries.length} 个条目`
              : view === "health"
                ? " — 密码健康"
                : " — 设置"}
        </div>
        {!isMac && (
          <div className="tb-btns">
            <button className="tb-btn" onClick={() => api.win.minimize()} title="最小化">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button className="tb-btn" onClick={() => api.win.toggleMaximize()} title="最大化/还原">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button className="tb-btn tb-close" onClick={() => api.win.close()} title="关闭">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {gate === "loading" && <div className="empty"><div className="big">🛡️</div></div>}

      {(gate === "create" || gate === "unlock") && (
        <Gate mode={gate} hint={hint} onDone={onGateDone} />
      )}

      {gate === "ready" && (
        <div className="app">
          {/* ===== 侧栏 ===== */}
          <aside className="sidebar">
            <div className="brand">
              <div className="logo">🛡️</div>
              <div>
                <b>神盾 Aegis</b>
                <span>Next · Electron</span>
              </div>
            </div>

            <button
              className={`nav-item ${view === "vault" && cat === "all" ? "active" : ""}`}
              onClick={() => { setView("vault"); setCat("all"); }}
            >
              <span>🗂</span> 全部条目 <span className="cnt">{entries.length}</span>
            </button>
            <button
              className={`nav-item ${view === "vault" && cat === "fav" ? "active" : ""}`}
              onClick={() => { setView("vault"); setCat("fav"); }}
            >
              <span>⭐</span> 收藏{" "}
              <span className="cnt">{entries.filter((e) => e.favorite).length}</span>
            </button>
            <button
              className={`nav-item ${view === "health" ? "active" : ""}`}
              onClick={() => setView("health")}
            >
              <span>🩺</span> 密码健康 <span className="cnt">{problems}</span>
            </button>
            <button
              className={`nav-item ${view === "settings" ? "active" : ""}`}
              onClick={() => setView("settings")}
            >
              <span>⚙</span> 设置
            </button>

            <div className="nav-sep" />

            <button className="nav-item" onClick={() => setModal({ kind: "entry", entry: null })}>
              <span>➕</span> 新增条目
            </button>
            <button className="nav-item" onClick={doImport}>
              <span>📥</span> 导入…
            </button>
            <button className="nav-item" onClick={() => setCmdOpen(true)}>
              <span>⌘</span> 命令面板 <span className="cnt">Ctrl K</span>
            </button>
            <button className="nav-item" onClick={cycleTheme}>
              <span>{theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}</span>
              主题：{themeLabel}
            </button>
            <button className="nav-item" onClick={() => patchSettings({ glass: !glassOn })}>
              <span>❖</span> 玻璃效果：{glassOn ? "开" : "关"}
            </button>
            <button className="nav-item" onClick={lockVault}>
              <span>🔒</span> 锁定密码库
            </button>

            <button className="health-card" onClick={() => setView("health")}>
              <div className="health-num">{localHealth.score}</div>
              <div>
                <div className="t">密码健康</div>
                <div className="s">{problems} 项待处理</div>
              </div>
            </button>
            <div className="stack-chip">
              <span className="ok-dot">●</span> {backend}
              <br />
              玻璃：{MATERIAL_LABEL[material]}
              {settings.autoLockMinutes > 0 ? ` · ${settings.autoLockMinutes} 分钟自动锁` : ""}
            </div>
          </aside>

          {/* ===== 健康检查页 / 设置页 顶掉「列表 + 详情」两栏 ===== */}
          {view === "health" && (
            <HealthPage
              entries={entries}
              hibpEnabled={settings.hibpEnabled}
              notify={notify}
              onOpenEntry={(id) => {
                setView("vault");
                setSelId(id);
                setShowPw(false);
              }}
            />
          )}

          {view === "settings" && (
            <SettingsPage
              settings={settings}
              onPatch={patchSettings}
              notify={notify}
              busy={busy}
              onImport={doImport}
              onExport={doExport}
              onBackup={doBackup}
            />
          )}

          {view === "vault" && (
            <>
              {/* ===== 条目列表 ===== */}
              <section className="listbar">
                <div className="search">
                  <span>🔍</span>
                  <input placeholder="搜索条目" value={query}
                    onChange={(e) => setQuery(e.target.value)} />
                </div>
                <div className="list-meta">
                  <span>{visible.length} 个条目</span>
                  <span>按更新时间</span>
                </div>
                <div className="entry-list">
                  {visible.map((e) => (
                    <button key={e.id} className={`row ${sel?.id === e.id ? "active" : ""}`}
                      onClick={() => { setSelId(e.id); setShowPw(false); }}>
                      <div className="avatar" style={{ background: avatarColor(e) }}>
                        {e.title.slice(0, 1) || "?"}
                      </div>
                      <div className="col">
                        <div className="t">{e.title || "(无标题)"}</div>
                        <div className="s">
                          {e.extra?.group ? `📁 ${e.extra.group} · ` : ""}
                          {e.username || e.url || "—"}
                        </div>
                      </div>
                      <div className="flags">
                        {e.extra?.totp && <span className="flag-2fa" title="已配置 TOTP">⏱</span>}
                        {e.favorite && <span className="fav-star">★</span>}
                        {(e.strength === "weak" || e.strength === "none") && (
                          <span className="dot-weak" />
                        )}
                      </div>
                    </button>
                  ))}
                  {visible.length === 0 && (
                    <div className="empty"><div className="big">🗂</div><div>没有条目</div></div>
                  )}
                </div>
              </section>

              {/* ===== 详情 ===== */}
              <main className="detail">
                {sel ? (
                  <div className="detail-card fade-in" key={sel.id}>
                    <div className="head">
                      <div className="avatar" style={{ background: avatarColor(sel) }}>
                        {sel.title.slice(0, 1) || "?"}
                      </div>
                      <div className="col">
                        <h1>{sel.title || "(无标题)"}</h1>
                        <div className="sub">{sel.username}</div>
                        <div className="chips">
                          <span className="chip">更新于 {timeStr(sel.updated_at)}</span>
                          <span className={`chip ${STRENGTH_LABEL[sel.strength].cls}`}>
                            {STRENGTH_LABEL[sel.strength].text}
                          </span>
                          {sel.extra?.group && <span className="chip">📁 {sel.extra.group}</span>}
                        </div>
                      </div>
                      <div className="head-actions">
                        <button className={`iconbtn ${sel.favorite ? "fav-on" : ""}`}
                          onClick={() => toggleFav(sel)} title="收藏">★</button>
                        <button className="iconbtn" onClick={() => setModal({ kind: "entry", entry: sel })}
                          title="编辑">✎</button>
                        <button className="iconbtn" onClick={() => removeEntry(sel)} title="删除">🗑</button>
                      </div>
                    </div>

                    <div className="field">
                      <div className="grow">
                        <div className="lbl">用户名</div>
                        <div className="val">{sel.username || "—"}</div>
                      </div>
                      <div className="ops">
                        <button className="iconbtn" title="复制用户名"
                          onClick={() => copyText(sel.username, "已复制用户名")}>⧉</button>
                      </div>
                    </div>

                    {sel.password ? (
                      <div className="field">
                        <div className="grow">
                          <div className="lbl">密码</div>
                          <div className="val">
                            {showPw ? (
                              <ColoredPassword value={sel.password} />
                            ) : (
                              <span className="mono">••••••••••••••••</span>
                            )}
                          </div>
                        </div>
                        <div className="ops">
                          <button className="iconbtn" onClick={() => setShowPw(!showPw)}>
                            {showPw ? "🙈" : "👁"}
                          </button>
                          <button className="iconbtn" title="复制密码"
                            onClick={() => copyText(sel.password, "已复制密码")}>⧉</button>
                        </div>
                      </div>
                    ) : (
                      <div className="field">
                        <div className="grow">
                          <div className="lbl">密码</div>
                          <div className="val" style={{ color: "var(--text-3)" }}>
                            尚未设置密码 —— 一键生成或自定义参数
                          </div>
                        </div>
                        <button className="gen-btn" onClick={() => genPassword(sel)}>🪄 生成强密码</button>
                        <button className="gen-ghost" onClick={() => setModal({ kind: "gen" })}>自定义参数…</button>
                      </div>
                    )}

                    {sel.extra?.totp && <TotpCard secret={sel.extra.totp} />}

                    {customFields.map(([k, v]) => (
                      <div className="field" key={k}>
                        <div className="grow">
                          <div className="lbl">{k.slice(6)}</div>
                          <div className="val">{v || "—"}</div>
                        </div>
                        <div className="ops">
                          <button className="iconbtn" onClick={() => copyText(v, `已复制「${k.slice(6)}」`)}>⧉</button>
                        </div>
                      </div>
                    ))}

                    {sel.url && (
                      <div className="field">
                        <div className="grow">
                          <div className="lbl">网址</div>
                          <div className="val" style={{ color: "var(--accent)" }}>{sel.url}</div>
                        </div>
                        <div className="ops">
                          <button className="iconbtn" title="复制网址"
                            onClick={() => copyText(sel.url, "已复制网址")}>⧉</button>
                        </div>
                      </div>
                    )}

                    {sel.notes && (
                      <div className="field">
                        <div className="grow">
                          <div className="lbl">备注</div>
                          <div className="val" style={{ whiteSpace: "pre-wrap" }}>{sel.notes}</div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="empty">
                    <div className="big">🛡️</div>
                    <div>选择或新增一条条目</div>
                    <button className="gen-btn" onClick={() => setModal({ kind: "entry", entry: null })}>
                      ➕ 新增条目
                    </button>
                  </div>
                )}
              </main>
            </>
          )}
        </div>
      )}

      {/* ===== 弹窗 ===== */}
      {cmdOpen && (
        <CommandPalette
          entries={entries}
          onClose={() => setCmdOpen(false)}
          onCopy={(t) => copyText(t, "已复制密码")}
          onSelectEntry={(id) => {
            setView("vault");
            setSelId(id);
            setShowPw(false);
          }}
          onAction={onPaletteAction}
        />
      )}
      {modal?.kind === "entry" && (
        <EntryModal
          initial={modal.entry}
          genDefaults={genDefaultsOf(settings)}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refresh();
          }}
        />
      )}
      {modal?.kind === "gen" && (
        <GeneratorModal
          defaults={genDefaultsOf(settings)}
          onClose={() => setModal(null)}
          onUse={async (pw) => {
            if (sel) {
              await api.vault.update(sel.id, { password: pw });
              await refresh(sel.id);
              setShowPw(true);
            }
          }}
        />
      )}
      {candidate && (
        <ImportPreviewModal
          candidate={candidate}
          notify={notify}
          onClose={() => setCandidate(null)}
          onDone={async (added, skipped) => {
            setCandidate(null);
            await refresh();
            notify(
              skipped > 0 ? `导入完成：新增 ${added} 条，跳过重复 ${skipped} 条` : `导入完成：新增 ${added} 条`,
              "ok",
            );
            setView("vault");
          }}
        />
      )}

      <Toasts items={toasts} />
    </div>
  );
}
