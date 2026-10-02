import { useEffect, useMemo, useState } from "react";

type Strength = "good" | "fair" | "weak" | "none";

type Entry = {
  id: number;
  title: string;
  user: string;
  url: string;
  hue: number;
  strength: Strength;
  totp?: boolean;
  fav?: boolean;
  updated: string;
};

const AVATAR_COLORS = [
  "#5E9CE6", "#7A6FE0", "#E07A5F", "#2FA356", "#E09B3C",
  "#4CB9B1", "#D96BA0", "#6B8FD9",
];

const MOCK: Entry[] = [
  { id: 1, title: "GitHub", user: "dev@example.com", url: "https://github.com", hue: 0, strength: "good", totp: true, fav: true, updated: "10-01 21:14" },
  { id: 2, title: "京东商城", user: "13800001234", url: "https://jd.com", hue: 1, strength: "weak", updated: "09-28 12:03" },
  { id: 3, title: "微博", user: "@aegis_user", url: "https://weibo.com", hue: 2, strength: "weak", updated: "09-30 08:45" },
  { id: 4, title: "知乎", user: "me@example.com", url: "https://zhihu.com", hue: 3, strength: "none", updated: "09-25 19:22" },
  { id: 5, title: "Bilibili", user: "me@example.com", url: "https://bilibili.com", hue: 4, strength: "fair", totp: true, updated: "10-02 09:10" },
  { id: 6, title: "招商银行", user: "6225 **** 8866", url: "https://cmbchina.com", hue: 5, strength: "good", fav: true, updated: "09-12 15:37" },
  { id: 7, title: "Steam", user: "aegis_dev", url: "https://steampowered.com", hue: 6, strength: "fair", updated: "08-30 23:05" },
  { id: 8, title: "Notion", user: "team@example.com", url: "https://notion.so", hue: 7, strength: "good", totp: true, updated: "10-01 11:48" },
];

const NAV = [
  { key: "all", icon: "🗂", label: "全部条目" },
  { key: "fav", icon: "⭐", label: "收藏" },
  { key: "login", icon: "🔑", label: "登录" },
  { key: "bank", icon: "💳", label: "银行卡" },
  { key: "id", icon: "🪪", label: "身份" },
];

const STRENGTH_LABEL: Record<Strength, { text: string; cls: string }> = {
  good: { text: "强度 · 强", cls: "good" },
  fair: { text: "强度 · 一般", cls: "warn" },
  weak: { text: "强度 · 弱", cls: "bad" },
  none: { text: "未设置密码", cls: "bad" },
};

function avatarColor(e: Entry) {
  return AVATAR_COLORS[e.hue % AVATAR_COLORS.length];
}

declare global {
  interface Window {
    api: { greet: (name: string) => Promise<string> };
  }
}

// ---- IPC 适配: 同一份 UI 在两栈各接各的后端 ----
async function pingBackend(): Promise<string> {
  return window.api.greet("神盾");
}

export default function App() {
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState(1);
  const [showPw, setShowPw] = useState(false);
  const [backend, setBackend] = useState("后端连接中…");

  useEffect(() => {
    pingBackend()
      .then((m) => setBackend(m))
      .catch((e) => setBackend(`后端未连通: ${e}`));
  }, []);

  const entries = useMemo(() => {
    let list = MOCK;
    if (cat === "fav") list = list.filter((e) => e.fav);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (e) => e.title.toLowerCase().includes(q) || e.user.toLowerCase().includes(q),
      );
    }
    return list;
  }, [cat, query]);

  const sel = MOCK.find((e) => e.id === selId) ?? entries[0] ?? null;
  const problems = MOCK.filter((e) => e.strength === "weak" || e.strength === "none").length;
  const score = Math.max(0, 100 - problems * 9);

  function copy(text: string) {
    navigator.clipboard?.writeText(text);
  }

  return (
    <div className="app">
      {/* ===== 侧栏 ===== */}
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">🛡️</div>
          <div>
            <b>神盾 Aegis</b>
            <span>Next · 预览版</span>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item ${cat === n.key ? "active" : ""}`}
            onClick={() => setCat(n.key)}
          >
            <span>{n.icon}</span>
            {n.label}
            <span className="cnt">
              {n.key === "all"
                ? MOCK.length
                : n.key === "fav"
                  ? MOCK.filter((e) => e.fav).length
                  : n.key === "login"
                    ? MOCK.length - 1
                    : n.key === "bank"
                      ? 1
                      : 0}
            </span>
          </button>
        ))}
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
          <input
            placeholder="搜索条目"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="list-meta">
          <span>{entries.length} 个条目</span>
          <span>按更新时间</span>
        </div>
        <div className="entry-list">
          {entries.map((e) => (
            <button
              key={e.id}
              className={`row ${sel?.id === e.id ? "active" : ""}`}
              onClick={() => {
                setSelId(e.id);
                setShowPw(false);
              }}
            >
              <div className="avatar" style={{ background: avatarColor(e) }}>
                {e.title.slice(0, 1)}
              </div>
              <div className="col">
                <div className="t">{e.title}</div>
                <div className="s">{e.user}</div>
              </div>
              <div className="flags">
                {e.fav && <span className="fav-star">★</span>}
                {e.totp && <span className="badge-2fa">2FA</span>}
                {(e.strength === "weak" || e.strength === "none") && (
                  <span className="dot-weak" />
                )}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ===== 详情 ===== */}
      <main className="detail">
        {sel ? (
          <div className="detail-card fade-in" key={sel.id}>
            <div className="head">
              <div className="avatar" style={{ background: avatarColor(sel) }}>
                {sel.title.slice(0, 1)}
              </div>
              <div className="col">
                <h1>{sel.title}</h1>
                <div className="sub">{sel.user}</div>
                <div className="chips">
                  <span className="chip">更新于 {sel.updated}</span>
                  <span className={`chip ${STRENGTH_LABEL[sel.strength].cls}`}>
                    {STRENGTH_LABEL[sel.strength].text}
                  </span>
                  {sel.totp && <span className="chip good">两步验证已开启</span>}
                </div>
              </div>
              <div className="head-actions">
                <button className={`iconbtn ${sel.fav ? "fav-on" : ""}`}>★</button>
                <button className="iconbtn">✎</button>
              </div>
            </div>

            <div className="field">
              <div className="grow">
                <div className="lbl">用户名</div>
                <div className="val">{sel.user}</div>
              </div>
              <div className="ops">
                <button className="iconbtn" onClick={() => copy(sel.user)}>⧉</button>
              </div>
            </div>

            <div className="field">
              <div className="grow">
                <div className="lbl">密码</div>
                <div className="val mono">
                  {sel.strength === "none"
                    ? "（尚未设置密码）"
                    : showPw
                      ? "Str0ng!Pass-2026#x"
                      : "••••••••••••••••"}
                </div>
              </div>
              <div className="ops">
                {sel.strength !== "none" && (
                  <>
                    <button
                      className="iconbtn"
                      onClick={() => setShowPw(!showPw)}
                    >
                      {showPw ? "🙈" : "👁"}
                    </button>
                    <button
                      className="iconbtn"
                      onClick={() => copy("Str0ng!Pass-2026#x")}
                    >
                      ⧉
                    </button>
                  </>
                )}
              </div>
            </div>

            {sel.strength === "none" ? (
              <div className="field">
                <div className="grow">
                  <div className="lbl">密码</div>
                  <div className="val" style={{ color: "var(--text-3)" }}>
                    一键生成 20 位强密码，旧值自动入历史
                  </div>
                </div>
                <button className="gen-btn">🪄 生成强密码</button>
                <button className="gen-ghost">自定义参数…</button>
              </div>
            ) : null}

            <div className="field">
              <div className="grow">
                <div className="lbl">网址</div>
                <div className="val" style={{ color: "var(--accent)" }}>{sel.url}</div>
              </div>
              <div className="ops">
                <button className="iconbtn">↗</button>
                <button className="iconbtn" onClick={() => copy(sel.url)}>⧉</button>
              </div>
            </div>

            {sel.totp && (
              <div className="field">
                <div className="grow">
                  <div className="lbl">动态验证码 (TOTP)</div>
                  <div className="totp-code">
                    493 207<span className="totp-sec">18s</span>
                  </div>
                </div>
                <div className="ops">
                  <button className="iconbtn" onClick={() => copy("493207")}>⧉</button>
                </div>
              </div>
            )}

            <div className="field">
              <div className="grow">
                <div className="lbl">自动填充</div>
                <div className="val" style={{ color: "var(--text-2)" }}>
                  跟随全局默认（用户名 + 密码）
                </div>
              </div>
              <div className="ops">
                <button className="iconbtn">⌨</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="big">🛡️</div>
            <div>没有找到匹配的条目</div>
          </div>
        )}
      </main>
    </div>
  );
}
