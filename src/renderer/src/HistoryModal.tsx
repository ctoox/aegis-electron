import { useEffect, useMemo, useState } from "react";
import type { Entry, EntryWithStrength } from "../../core/types";
import { FIELD_LABELS, SNAPSHOT_FIELDS, type Snapshot } from "../../core/history";
import { api, cleanError } from "./api";
import type { ToastKind } from "./Toast";

/**
 * 条目历史版本 —— 入口在条目详情的「历史」按钮。
 *
 * 每次编辑只要动了核心字段 (标题/用户名/密码/网址/备注), 旧值就被整份存下来。
 * 这里把它倒序摊开, 标出"与当前相比差在哪几个字段", 并提供一键回滚。
 *
 * 关键设计: 回滚本身也会被记成一条新历史 —— 所以"退回错了"可以再退回来,
 * 不存在"越恢复越糟"的情况。UI 上也要把这句话讲出来, 否则用户不敢点。
 */
export function HistoryModal(props: {
  entry: EntryWithStrength;
  onClose: () => void;
  onRestored: (e: Entry) => void;
  notify: (text: string, kind?: ToastKind) => void;
}) {
  const { entry, onClose, onRestored, notify } = props;
  const [hist, setHist] = useState<Snapshot[] | null>(null);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    let alive = true;
    api.vault
      .history(entry.id)
      .then((h) => alive && setHist(h))
      .catch((e) => {
        if (alive) {
          setHist([]);
          notify(cleanError(e), "err");
        }
      });
    return () => {
      alive = false;
    };
  }, [entry.id, notify]);

  /** 倒序: 最近的一次改动排最前 (原数组是"最旧在前") */
  const rows = useMemo(
    () => (hist ?? []).map((s, i) => ({ snap: s, idx: i })).reverse(),
    [hist],
  );

  async function restore(idx: number) {
    setBusyIdx(idx);
    try {
      const updated = await api.vault.restoreHistory(entry.id, idx);
      onRestored(updated);
      notify("已恢复到该版本（这次恢复也记进了历史，随时能再退回来）", "ok");
      onClose();
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusyIdx(null);
    }
  }

  const cur: Record<string, string> = {
    title: entry.title,
    username: entry.username,
    password: entry.password,
    url: entry.url,
    notes: entry.notes,
  };
  const changedKinds = (s: Snapshot) =>
    SNAPSHOT_FIELDS.filter((k) => (s[k] ?? "") !== (cur[k] ?? ""));

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal wide fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>历史版本 · {entry.title || "(无标题)"}</h2>

        {hist === null && <p className="hist-empty">读取中…</p>}

        {hist !== null && rows.length === 0 && (
          <p className="hist-empty">
            还没有历史记录。条目第一次改动核心字段（标题 / 用户名 / 密码 / 网址 /
            备注）之后，旧值就会出现在这里。
          </p>
        )}

        {rows.length > 0 && (
          <>
            <p className="hist-note">
              共 {rows.length} 个历史版本（最多保留 20 个）。回滚会写入一条新的历史记录，
              所以恢复错了还能再恢复回来 —— 不会越改越乱。
              <button className="link" onClick={() => setShowPw((v) => !v)}>
                {showPw ? "隐藏密码" : "显示密码"}
              </button>
            </p>

            <ul className="hist-list">
              {rows.map(({ snap, idx }) => {
                const kinds = changedKinds(snap);
                return (
                  <li key={idx} className="hist-item">
                    <div className="hist-head">
                      <span className="hist-time">{timeText(snap.at)}</span>
                      <span className={"hist-diff" + (kinds.length ? "" : " same")}>
                        {kinds.length
                          ? `与当前相比：${kinds.map((k) => FIELD_LABELS[k]).join("、")} 不同`
                          : "与当前完全一致"}
                      </span>
                      <button
                        className="hist-restore"
                        disabled={busyIdx !== null}
                        onClick={() => restore(idx)}
                      >
                        {busyIdx === idx ? "恢复中…" : "恢复到此版本"}
                      </button>
                    </div>
                    <dl className="hist-fields">
                      {SNAPSHOT_FIELDS.filter((k) => kinds.includes(k)).map((k) => (
                        <div key={k}>
                          <dt>{FIELD_LABELS[k]}</dt>
                          <dd>
                            {k === "password" && !showPw
                              ? snap[k]
                                ? "••••••••"
                                : "（空）"
                              : snap[k] || "（空）"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="modal-btns">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function timeText(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
