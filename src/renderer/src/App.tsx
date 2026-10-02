import { useEffect, useMemo, useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { api } from "./api";
import { EntryModal } from "./EntryModal";
import { Gate } from "./Gate";
import { GeneratorModal } from "./GeneratorModal";

type GateMode = "loading" | "create" | "unlock" | "ready";

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

export default function App() {
  const [gate, setGate] = useState<GateMode>("loading");
  const [hint, setHint] = useState("");
  const [entries, setEntries] = useState<EntryWithStrength[]>([]);
  const [cat, setCat] = useState<"all" | "fav">("all");
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [modal, setModal] = useState<
    | { kind: "entry"; entry: EntryWithStrength | null }
    | { kind: "gen" }
    | null
  >(null);
  const [backend, setBackend] = useState("后端连接中…");

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

  async function onGateDone() {
    setGate("ready");
    await refresh();
  }

  async function toggleFav(e: EntryWithStrength) {
    await api.vault.update(e.id, { favorite: !e.favorite });
    await refresh(e.id);
  }

  async function genPassword(e: EntryWithStrength) {
    const pw = await api.pw.generate({
      length: 20, useUpper: true, useLower: true,
      useDigits: true, useSymbols: true, minDigits: 1, minSymbols: 1,
    });
    await api.vault.update(e.id, { password: pw });
    await refresh(e.id);
    setShowPw(true);
  }

  async function removeEntry(e: EntryWithStrength) {
    if (!confirm(`确定删除「${e.title}」吗？此操作不可撤销。`)) return;
    await api.vault.remove(e.id);
    await refresh();
  }

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
  const problems = entries.filter(
    (e) => e.strength === "weak" || e.strength === "none",
  ).length;
  const score = Math.max(0, 100 - problems * 9);

  return (
    <div className="shell">
      {/* ===== 自绘标题栏 ===== */}
      <div className="titlebar" data-tauri-drag-region>
        <div className="tb-title" data-tauri-drag-region>
          🛡️ 神盾 Aegis{gate !== "ready" ? "" : ` — ${entries.length} 个条目`}
        </div>
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
            <button className={`nav-item ${cat === "all" ? "active" : ""}`} onClick={() => setCat("all")}>
              <span>🗂</span> 全部条目 <span className="cnt">{entries.length}</span>
            </button>
            <button className={`nav-item ${cat === "fav" ? "active" : ""}`} onClick={() => setCat("fav")}>
              <span>⭐</span> 收藏{" "}
              <span className="cnt">{entries.filter((e) => e.favorite).length}</span>
            </button>
            <button className="nav-item" onClick={() => setModal({ kind: "entry", entry: null })}>
              <span>➕</span> 新增条目
            </button>
            <div className="health-card">
              <div className="health-num">{score}</div>
              <div>
                <div className="t">密码健康</div>
                <div className="s">{problems} 项待处理</div>
              </div>
            </div>
            <div className="stack-chip">
              <span className="ok-dot">●</span> {backend}
            </div>
          </aside>

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
                    <div className="s">{e.username || e.url || "—"}</div>
                  </div>
                  <div className="flags">
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
                    <button className="iconbtn" onClick={() => navigator.clipboard?.writeText(sel.username)}>⧉</button>
                  </div>
                </div>

                {sel.password ? (
                  <div className="field">
                    <div className="grow">
                      <div className="lbl">密码</div>
                      <div className="val mono">
                        {showPw ? sel.password : "••••••••••••••••"}
                      </div>
                    </div>
                    <div className="ops">
                      <button className="iconbtn" onClick={() => setShowPw(!showPw)}>
                        {showPw ? "🙈" : "👁"}
                      </button>
                      <button className="iconbtn"
                        onClick={() => navigator.clipboard?.writeText(sel.password)}>⧉</button>
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

                {sel.url && (
                  <div className="field">
                    <div className="grow">
                      <div className="lbl">网址</div>
                      <div className="val" style={{ color: "var(--accent)" }}>{sel.url}</div>
                    </div>
                    <div className="ops">
                      <button className="iconbtn"
                        onClick={() => navigator.clipboard?.writeText(sel.url)}>⧉</button>
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
        </div>
      )}

      {/* ===== 弹窗 ===== */}
      {modal?.kind === "entry" && (
        <EntryModal
          initial={modal.entry}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            refresh();
          }}
        />
      )}
      {modal?.kind === "gen" && (
        <GeneratorModal
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
    </div>
  );
}
