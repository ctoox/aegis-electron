import { useEffect, useMemo, useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { ISSUE_META, analyzeLocal, scoreGrade, type HealthReport, type IssueKind } from "../../core/health";
import { api, cleanError } from "./api";
import { ColoredPassword } from "./ColoredPassword";
import type { ToastKind } from "./Toast";

const GRADE_LABEL: Record<ReturnType<typeof scoreGrade>, string> = {
  excellent: "极佳",
  good: "良好",
  fair: "一般",
  poor: "堪忧",
};

const CARDS: { kind: IssueKind; key: keyof HealthReport | "checked" }[] = [
  { kind: "pwned", key: "pwned" },
  { kind: "weak", key: "weak" },
  { kind: "reused", key: "reused" },
  { kind: "http", key: "http" },
  { kind: "no2fa", key: "no2fa" },
];

const FILTERS: { id: "all" | IssueKind; label: string }[] = [
  { id: "all", label: "全部问题" },
  { id: "pwned", label: "已泄露" },
  { id: "weak", label: "弱密码" },
  { id: "reused", label: "重复使用" },
  { id: "http", label: "明文 HTTP" },
  { id: "no2fa", label: "缺两步验证" },
];

export function HealthPage(props: {
  entries: EntryWithStrength[];
  onOpenEntry: (id: string) => void;
  notify: (text: string, kind?: ToastKind) => void;
  hibpEnabled: boolean;
}) {
  const { entries, onOpenEntry, notify, hibpEnabled } = props;
  // 本地体检 (无网络) 是同步纯函数, 直接算, 保证首屏立即有分数
  const local = useMemo(() => analyzeLocal(entries), [entries]);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState<"local" | "deep" | null>(null);
  const [filter, setFilter] = useState<"all" | IssueKind>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const shown: HealthReport = report ?? {
    ...local,
    pwned: 0,
    breachChecked: 0,
    breachDisabled: true,
    generatedAt: 0,
  };

  // 条目变了 (增删改) 就把联网结果丢掉, 避免显示旧报告
  useEffect(() => {
    setReport(null);
  }, [entries]);

  async function run(deep: boolean) {
    setBusy(deep ? "deep" : "local");
    try {
      const r = await api.health.report(deep);
      setReport(r);
      if (r.breachError) notify(`泄露检测未完成：${r.breachError}`, "warn");
      else if (deep) notify(`深度体检完成，检查了 ${r.breachChecked} 条密码`, "ok");
      else notify("本地快速体检完成", "ok");
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const issues = report?.issues ?? local.issues;
  const list = filter === "all" ? issues : issues.filter((i) => i.kind === filter);
  const grade = scoreGrade(shown.score);
  const R = 54;
  const C = 2 * Math.PI * R;

  return (
    <main className="page health-page">
      <header className="page-head">
        <div>
          <h1>密码健康</h1>
          <p className="page-sub">
            对照 Bitwarden 的保险库健康报表：已泄露 / 弱密码 / 重复使用 / 明文 HTTP / 缺两步验证
          </p>
        </div>
        <div className="page-actions">
          <button className="btn-ghost" disabled={busy !== null} onClick={() => run(false)}>
            {busy === "local" ? "体检中…" : "本地快速体检"}
          </button>
          <button
            className="gen-btn"
            disabled={busy !== null || !hibpEnabled}
            title={hibpEnabled ? "只发送密码 SHA-1 的前 5 位，k-匿名查询" : "已在设置里关闭泄露检测"}
            onClick={() => run(true)}
          >
            {busy === "deep" ? "联网查询中…" : "联网深度体检"}
          </button>
        </div>
      </header>

      <div className="health-top">
        <div className={`score-ring ${grade}`}>
          <svg viewBox="0 0 128 128" width="128" height="128">
            <circle cx="64" cy="64" r={R} className="ring-bg" />
            <circle
              cx="64"
              cy="64"
              r={R}
              className="ring-fg"
              strokeDasharray={`${(shown.score / 100) * C} ${C}`}
              transform="rotate(-90 64 64)"
            />
          </svg>
          <div className="score-inner">
            <b>{shown.score}</b>
            <span>{GRADE_LABEL[grade]}</span>
          </div>
        </div>

        <div className="health-cards">
          {CARDS.map(({ kind, key }) => {
            const n = Number(shown[key as keyof HealthReport] ?? 0);
            const meta = ISSUE_META[kind];
            const na = kind === "pwned" && shown.breachDisabled;
            return (
              <button
                key={kind}
                className={`hcard ${meta.severity} ${n > 0 ? "hit" : ""} ${na ? "na" : ""}`}
                onClick={() => setFilter(kind)}
              >
                <span className="hc-ic">{meta.icon}</span>
                <span className="hc-n">{na ? "—" : n}</span>
                <span className="hc-t">{meta.label}</span>
              </button>
            );
          })}
          <div className="hcard info">
            <span className="hc-ic">≡</span>
            <span className="hc-n">{local.scored}</span>
            <span className="hc-t">有密码的条目</span>
          </div>
        </div>
      </div>

      <div className="health-note">
        {shown.breachDisabled ? (
          hibpEnabled
            ? "泄露检测需要联网。点「联网深度体检」用 HIBP 的 k-匿名接口查询（只发送密码 SHA-1 的前 5 位）。"
            : "已在设置里关闭「泄露检测」，仅做本地体检。"
        ) : shown.breachError ? (
          <span className="bad">泄露检测失败：{shown.breachError}（本地结果仍然有效）</span>
        ) : (
          <>
            已联网检查 <b>{shown.breachChecked}</b> 条去重密码，
            {shown.pwned > 0 ? <span className="bad"> 命中 {shown.pwned} 条</span> : " 无命中"}
            {shown.generatedAt ? ` · ${new Date(shown.generatedAt).toLocaleTimeString("zh-CN")}` : ""}
          </>
        )}
      </div>

      <div className="health-body">
        <div className="health-list">
          <div className="list-meta">
            <div className="filter-tabs">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`ftab ${filter === f.id ? "active" : ""}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span>{list.length} 项</span>
          </div>
          {list.length === 0 ? (
            <div className="empty">
              <div className="big">🎉</div>
              <div>{filter === "all" ? "没有发现任何问题" : "这一类没有问题"}</div>
            </div>
          ) : (
            <div className="issue-list">
              {list.map((i, idx) => {
                const meta = ISSUE_META[i.kind];
                return (
                  <div
                    key={`${i.entryId}-${i.kind}-${idx}`}
                    className={`issue ${meta.severity} ${openId === i.entryId ? "open" : ""}`}
                  >
                    <button className="issue-head" onClick={() => setOpenId(openId === i.entryId ? null : i.entryId)}>
                      <span className="issue-ic">{meta.icon}</span>
                      <span className="issue-main">
                        <span className="t">{i.title}</span>
                        <span className="s">{i.username || "—"}</span>
                      </span>
                      <span className={`chip sev-${meta.severity}`}>{meta.label}</span>
                      <span className="issue-detail">{i.detail}</span>
                    </button>
                    {openId === i.entryId && <IssuePeek id={i.entryId} onOpen={onOpenEntry} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <aside className="health-side">
          <h3>强度分布</h3>
          {(
            [
              ["good", "强", "var(--ok)"],
              ["fair", "一般", "var(--warn)"],
              ["weak", "弱", "var(--danger)"],
              ["none", "未设置", "var(--text-3)"],
            ] as const
          ).map(([k, label, color]) => {
            const n = local.distribution[k];
            const pct = local.scored > 0 ? Math.round((n / Math.max(entries.length, 1)) * 100) : 0;
            return (
              <div className="dist-row" key={k}>
                <span className="dl">{label}</span>
                <span className="dbar">
                  <i style={{ width: `${pct}%`, background: color }} />
                </span>
                <span className="dn">{n}</span>
              </div>
            );
          })}

          {local.reuseGroups.length > 0 && (
            <>
              <h3>重复密码分组</h3>
              {local.reuseGroups.slice(0, 6).map((g, i) => (
                <div className="reuse-group" key={i}>
                  <div className="rg-head">
                    <b>{g.count}</b> 个条目共用
                  </div>
                  <div className="rg-titles">{g.titles.slice(0, 4).join(" · ")}{g.titles.length > 4 ? " …" : ""}</div>
                </div>
              ))}
            </>
          )}

          <h3>说明</h3>
          <ul className="tips">
            <li>「已泄露」来自 Have I Been Pwned 的 Pwned Passwords 库，查询过程只发送密码 SHA-1 的前 5 位（k-匿名），服务端无法得知完整密码。</li>
            <li>健康分为本机计算，权重：泄露 &gt; 弱密码 &gt; 明文 HTTP &gt; 重复使用 &gt; 缺两步验证。</li>
            <li>断网时泄露检测会失败，但本地四项结果不受影响。</li>
          </ul>
        </aside>
      </div>
    </main>
  );
}

/** 展开后预览条目内容 (不跳走也能看个大概) */
function IssuePeek({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [entry, setEntry] = useState<EntryWithStrength | null>(null);
  useEffect(() => {
    let alive = true;
    api.vault
      .list()
      .then((l) => alive && setEntry(l.find((e) => e.id === id) ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  if (!entry) return null;
  return (
    <div className="issue-peek">
      <div className="peek-field">
        <span className="lbl">用户名</span>
        <span className="val">{entry.username || "—"}</span>
      </div>
      <div className="peek-field">
        <span className="lbl">密码</span>
        <span className="val">
          <ColoredPassword value={entry.password || "(空)"} />
        </span>
      </div>
      {entry.url && (
        <div className="peek-field">
          <span className="lbl">网址</span>
          <span className="val">{entry.url}</span>
        </div>
      )}
      <button className="btn-ghost sm" onClick={() => onOpen(entry.id)}>
        打开条目 →
      </button>
    </div>
  );
}
