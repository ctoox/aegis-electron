import { useState } from "react";
import { api, cleanError, type ImportCandidate } from "./api";
import type { ToastKind } from "./Toast";

/**
 * 导入预览弹窗.
 * 文件读取与解析都在主进程完成, 这里只负责"让用户看清要进来什么, 再决定"
 * —— 密码管理器里"导入"是不可逆的批量写入, 必须给人一次反悔的机会.
 */
export function ImportPreviewModal(props: {
  candidate: ImportCandidate;
  onClose: () => void;
  onDone: (added: number, skipped: number) => void;
  notify: (text: string, kind?: ToastKind) => void;
}) {
  const { candidate, onClose, onDone, notify } = props;
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  async function commit() {
    setBusy(true);
    try {
      const r = await api.portable.commitImport(candidate.entries, { skipDuplicates });
      onDone(r.added, r.skipped);
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setBusy(false);
    }
  }

  const preview = candidate.entries.slice(0, 12);

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal wide fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>导入预览</h2>
        <div className="imp-meta">
          <div><span>文件</span><b>{candidate.fileName}</b></div>
          <div><span>识别格式</span><b>{candidate.label}</b></div>
          <div><span>条目数</span><b>{candidate.entries.length}</b></div>
          <div><span>大小</span><b>{(candidate.bytes / 1024).toFixed(1)} KB</b></div>
        </div>

        {candidate.groups.length > 0 && (
          <p className="imp-line">
            分组：{candidate.groups.slice(0, 12).join("、")}
            {candidate.groups.length > 12 ? ` 等 ${candidate.groups.length} 个` : ""}
          </p>
        )}

        {candidate.warnings.length > 0 && (
          <ul className="imp-warn">
            {candidate.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}

        <div className="imp-table">
          <div className="imp-tr head">
            <span>标题</span>
            <span>用户名</span>
            <span>
              密码{" "}
              <button className="link" onClick={() => setShowPasswords((v) => !v)}>
                {showPasswords ? "隐藏" : "显示"}
              </button>
            </span>
            <span>网址</span>
            <span>分组</span>
          </div>
          {preview.map((e, i) => (
            <div className="imp-tr" key={i}>
              <span>{e.title || "(无标题)"}</span>
              <span>{e.username || "—"}</span>
              <span className="mono">{showPasswords ? e.password || "—" : "••••••"}</span>
              <span className="ellip">{e.url || "—"}</span>
              <span className="ellip">{e.extra?.group || "—"}</span>
            </div>
          ))}
          {candidate.entries.length > preview.length && (
            <div className="imp-more">… 还有 {candidate.entries.length - preview.length} 条</div>
          )}
        </div>

        <label className="imp-check">
          <input
            type="checkbox"
            checked={skipDuplicates}
            onChange={(e) => setSkipDuplicates(e.target.checked)}
          />
          跳过重复条目（标题 + 用户名都相同的视为已存在）
        </label>

        <div className="modal-btns">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={commit}>
            {busy ? "导入中…" : `确认导入 ${candidate.entries.length} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}
