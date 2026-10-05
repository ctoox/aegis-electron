import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { analyzeLocal } from "../../core/health";
import { FORMATS, type FormatId } from "../../core/formats";
import { DEFAULT_SETTINGS, hotkeyLabel, type Settings } from "../../core/prefs";
import { api, cleanError, type ImportCandidate } from "./api";
import type { ShareCandidate } from "./api";
import { BulkDeleteModal } from "./BulkDelete";
import { ColoredPassword } from "./ColoredPassword";
import { CommandPalette } from "./CommandPalette";
import { EntryModal } from "./EntryModal";
import { Gate } from "./Gate";
import { GeneratorModal } from "./GeneratorModal";
import { HealthPage } from "./HealthPage";
import { HistoryModal } from "./HistoryModal";
import { ImportPreviewModal } from "./ImportExport";
import {
  ShareExportModal,
  ShareImportModal,
  pickShare,
} from "./ShareModals";
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
  // ---- 分享包 / 条目历史 ----
  /** 要分享的条目 id; null = 弹窗没开. 空数组 = 没勾选 → 默认整个库 */
  const [shareIds, setShareIds] = useState<string[] | null>(null);
  const [shareCand, setShareCand] = useState<ShareCandidate | null>(null);
  const [histEntry, setHistEntry] = useState<EntryWithStrength | null>(null);
  // ---- 列表多选 / 批量删除 ----
  // selectMode 打开后点击行变成「勾选」; anchorId 记录上次点击的行, 供 Shift 区间选择
  const [selectMode, setSelectMode] = useState(false);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
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

  // 全局快捷键: Ctrl/Cmd+K 命令面板, Ctrl/Cmd+M 多选模式(任何分类页都能进)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (gate === "ready") setCmdOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
        e.preventDefault();
        if (gate !== "ready") return;
        setView("vault");
        if (selectMode) {
          setSelectMode(false);
          setSelIds(new Set());
          setAnchorId(null);
        } else {
          setSelectMode(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate, selectMode]);

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
          // hint 不在这里读 —— 交给下面那个「每次进解锁页就读一次」的 effect,
          // 免得挂载和进站两处各读一遍、各留一份可能过期的副本
          setGate(s.exists ? "unlock" : "create");
        }
      })
      .catch(() => setGate("create"));
    api
      .greet("神盾")
      .then((m) => setBackend(m))
      .catch((e) => setBackend(`后端未连通: ${e}`));
  }, []);

  /**
   * 每次「进入解锁页」都重读一次提示语。
   *
   * hint 明文存在库文件头里, 「改主密码 / 重置 / 新建库」都会把它换掉。
   * 若只在挂载时读一次, 改完再锁库, 解锁页显示的还是启动那一刻的旧提示 ——
   * 用户看到的就是"提示改不动"。挂在 gate 变成 unlock 这一刻, 就把所有
   * 会锁库的路径(闲置超时 / 失焦 / 手动锁定 / 重置后回落)一次全覆盖了。
   */
  useEffect(() => {
    if (gate !== "unlock") return;
    let stale = false;
    api.vault
      .status()
      .then((s) => {
        if (!stale) setHint(s.hint);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [gate]);

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
      setShareIds(null);
      setShareCand(null);
      setHistEntry(null);
      setView("vault");
      setGate("unlock");
      exitSelect();
      if (reason === "idle") notify("闲置超时，密码库已自动锁定", "warn");
      else if (reason === "blur") notify("窗口失去焦点，密码库已锁定", "warn");
      else if (reason === "restore")
        notify("已从备份快照恢复，请用当时的密码解锁", "warn");
    });
  }, [notify]);

  // ---- 剪贴板被定时清空 ----
  useEffect(() => {
    return api.app.onClipboardCleared(() => notify("剪贴板已自动清空", "info"));
  }, [notify]);

  // ---- 快速填充的结果提示 ----
  // 填充常常发生在主窗口被最小化到托盘的时候，所以主进程那边同时也会写日志；
  // 这条订阅只负责"用户在看着主窗口"时给个明确交代。
  useEffect(() => {
    return api.atype.onNotice((msg) => notify(msg, "info"));
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
      // clearIn = 0 是设置里的「不清空」（跨机粘贴的人常这么选）。这时必须说清楚 ——
      // 只回一句「已复制」的话，用户会以为过一会儿它自己就没了，实际会一直留着。
      if (r.clearIn > 0) notify(`${label}，${r.clearIn} 秒后自动清空剪贴板`, "ok");
      else notify(`${label}（剪贴板不会自动清空 —— 用完从托盘菜单清除）`, "warn");
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

  // ---- 加密分享包 ----

  /** 导出: 有勾选就只包勾选的, 没勾选就是全库 */
  function doShareExport() {
    if (entries.length === 0) {
      notify("密码库是空的，没有可分享的条目", "warn");
      return;
    }
    setShareIds([...selIds]);
  }

  async function doShareImport() {
    setBusy(true);
    try {
      const c = await pickShare(notify);
      if (c) setShareCand(c);
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
    else if (id === "share-export") doShareExport();
    else if (id === "share-import") doShareImport();
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

  // ---- 列表多选 / 批量删除 ----
  /** 退出选择模式并清空勾选 (锁库 / 切视图 / 删完 都走这里) */
  function exitSelect() {
    setSelectMode(false);
    setSelIds(new Set());
    setAnchorId(null);
  }

  /** 勾选 / 取消单条 */
  function toggleSel(id: string) {
    setSelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchorId(id);
  }

  /** Shift 点击: 从上次点击处到当前行整段选中 (与已有勾选合并) */
  function selectRange(toId: string) {
    const a = visible.findIndex((x) => x.id === anchorId);
    const b = visible.findIndex((x) => x.id === toId);
    if (a < 0 || b < 0) {
      toggleSel(toId);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelIds((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(visible[i].id);
      return next;
    });
  }

  // 选择模式快捷键: Esc 退出, Ctrl/Cmd+A 全选当前可见列表
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectMode(false);
        setSelIds(new Set());
        setAnchorId(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelIds(new Set(visible.map((x) => x.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, visible]);

  // 离开条目列表 (去健康页 / 设置页) 就退出选择模式, 免得切回来还停在勾选态
  useEffect(() => {
    if (view !== "vault") {
      setSelectMode(false);
      setSelIds(new Set());
      setAnchorId(null);
    }
  }, [view]);

  /** 待删除条目 —— 弹窗要逐条列出来给用户看, 所以取完整对象而非只有 id */
  const bulkEntries = useMemo(
    () => entries.filter((e) => selIds.has(e.id)),
    [entries, selIds],
  );

  /** 当前可见列表是否已全部勾选 (决定全选框的三态显示) */
  const allChecked = visible.length > 0 && visible.every((e) => selIds.has(e.id));

  /** 全选框: 未全选 → 全选; 已全选 → 取消全选 */
  function toggleAllVisible() {
    setSelIds(allChecked ? new Set() : new Set(visible.map((x) => x.id)));
  }

  async function doBulkDelete() {
    const ids = bulkEntries.map((e) => e.id);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const n = await api.vault.removeMany(ids);
      setBulkOpen(false);
      exitSelect();
      await refresh();
      notify(`已删除 ${n} 个条目`, "ok");
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(false);
    }
  }

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
        <Gate
          mode={gate}
          hint={hint}
          onDone={onGateDone}
          onReset={(msg) => notify(msg, "warn")}
        />
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

            {/* 导航区单独滚动 —— 否则选项一多或窗口一矮, 底部的健康卡会被挤出侧栏 */}
            <div className="nav-scroll">
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
              <button className="nav-item" onClick={doShareExport}>
                <span>📤</span> 导出加密分享包
              </button>
              <button className="nav-item" onClick={doShareImport}>
                <span>🔐</span> 导入分享包
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  setView("vault");
                  setSelectMode(true);
                }}
              >
                <span>☑</span> 多选 / 批量删除
              </button>
              <button className="nav-item" onClick={() => setCmdOpen(true)}>
                <span>⌘</span> 命令面板 <span className="cnt">Ctrl K</span>
              </button>
              <button
                className="nav-item"
                onClick={() => void api.atype.open(sel?.title ?? "")}
                title="把账号密码自动打到别的窗口（也可用全局快捷键）"
              >
                <span>⌨</span> 快速填充
                {settings.autotypeEnabled && settings.autotypeHotkey && (
                  <span className="cnt">{hotkeyLabel(settings.autotypeHotkey, isMac ? "darwin" : "win32")}</span>
                )}
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
            </div>

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
              onShareExport={doShareExport}
              onShareImport={doShareImport}
              onChanged={() => {
                refresh().catch(() => {});
              }}
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
                {selectMode ? (
                  /* 选择工具条: 全选复选框 + 已选计数 + 批量操作 */
                  <div className="sel-toolbar">
                    <button
                      className={`sel-all ${allChecked ? "on" : ""}`}
                      onClick={toggleAllVisible}
                      title={allChecked ? "取消全选" : "全选当前列表"}
                    >
                      <span
                        className={`tick ${allChecked ? "on" : selIds.size > 0 ? "part" : ""}`}
                      >
                        {allChecked ? "✓" : selIds.size > 0 ? "–" : ""}
                      </span>
                      全选
                    </button>
                    <span className="sel-count">
                      已选 <b>{selIds.size}</b> / {visible.length}
                    </span>
                    <span className="grow" />
                    <button
                      className="cbtn danger"
                      disabled={selIds.size === 0}
                      onClick={() => setBulkOpen(true)}
                    >
                      🗑 删除{selIds.size > 0 ? ` ${selIds.size} 条` : ""}
                    </button>
                    <button className="cbtn" onClick={exitSelect}>
                      完成
                    </button>
                  </div>
                ) : (
                  <div className="list-meta">
                    <span>{visible.length} 个条目</span>
                    <span className="meta-ops">
                      {visible.length > 0 && (
                        <button
                          className="cbtn"
                          onClick={() => setSelectMode(true)}
                          title="多选（Ctrl+M）"
                        >
                          ☑ 多选
                        </button>
                      )}
                      <span>按更新时间</span>
                    </span>
                  </div>
                )}
                <div className={`entry-list ${selectMode ? "selecting" : ""}`}>
                  {visible.map((e) => {
                    const checked = selIds.has(e.id);
                    const active = !selectMode && sel?.id === e.id;
                    return (
                      <button
                        key={e.id}
                        className={`row ${active ? "active" : ""} ${checked ? "checked" : ""}`}
                        onClick={(ev) => {
                          if (!selectMode) {
                            setSelId(e.id);
                            setShowPw(false);
                            return;
                          }
                          // Shift 划一段, 普通点击勾/取消一条
                          if (ev.shiftKey) selectRange(e.id);
                          else toggleSel(e.id);
                        }}
                      >
                        {selectMode && (
                          <span className={`row-check ${checked ? "on" : ""}`}>
                            {checked ? "✓" : ""}
                          </span>
                        )}
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
                    );
                  })}
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
                        <button className="iconbtn" onClick={() => setHistEntry(sel)}
                          title="历史版本">🕘</button>
                        <button className="iconbtn" onClick={() => setShareIds([sel.id])}
                          title="分享此条目">📤</button>
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
      {bulkOpen && (
        <BulkDeleteModal
          entries={bulkEntries}
          busy={busy}
          notify={notify}
          onClose={() => setBulkOpen(false)}
          onConfirm={doBulkDelete}
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

      {shareIds !== null && (
        <ShareExportModal
          selected={entries.filter((e) => shareIds.includes(e.id))}
          all={entries}
          onClose={() => setShareIds(null)}
          notify={notify}
        />
      )}

      {shareCand && (
        <ShareImportModal
          candidate={shareCand}
          notify={notify}
          onClose={() => setShareCand(null)}
          onDone={async (added, skipped, rekeyed) => {
            setShareCand(null);
            await refresh();
            const extra = [
              skipped > 0 ? `跳过损坏 ${skipped} 条` : "",
              rekeyed > 0 ? `${rekeyed} 条重新分配了 ID` : "",
            ]
              .filter(Boolean)
              .join("，");
            notify(
              `分享包导入完成：新增 ${added} 条${extra ? `（${extra}）` : ""}`,
              "ok",
            );
            setView("vault");
          }}
        />
      )}

      {histEntry && (
        <HistoryModal
          entry={histEntry}
          notify={notify}
          onClose={() => setHistEntry(null)}
          onRestored={async (updated) => {
            await refresh(updated.id);
            setHistEntry(null);
          }}
        />
      )}

      <Toasts items={toasts} />
    </div>
  );
}
