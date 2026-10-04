import { useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { api, cleanError } from "./api";
import type { ToastKind } from "./Toast";

/**
 * 批量删除确认弹窗.
 *
 * 三重防线, 全是为了挡住"连点两下就把库清了"这种事故:
 *   1. 把要删的条目逐条列出来 (超过 8 条折叠、可展开) —— 让人看清 Shift 到底划进来了什么;
 *   2. 必须手打确认词「删除」或者输入主密码 —— 不接受"直接点确定";
 *   3. 主密码走一次真实的 Argon2id 重新派生校验, 不是比对内存里缓存的字符串.
 */
const PREVIEW_LIMIT = 8;
const CONFIRM_WORD = "删除";

export function BulkDeleteModal(props: {
  entries: EntryWithStrength[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  notify: (text: string, kind?: ToastKind) => void;
}) {
  const { entries, busy, onClose, onConfirm, notify } = props;
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);

  const shown = expanded ? entries : entries.slice(0, PREVIEW_LIMIT);
  const rest = entries.length - shown.length;
  const working = busy || checking;

  /** 主密码校验要现算一次 Argon2id (64MiB, 约半秒), 期间锁住按钮防连点 */
  async function confirm() {
    const v = text.trim();
    if (!v || working) return;
    if (v === CONFIRM_WORD) {
      onConfirm();
      return;
    }
    setChecking(true);
    try {
      if (await api.vault.verify(v)) onConfirm();
      else notify("确认文字不对，也不是当前库的主密码", "err");
    } catch (e) {
      notify(cleanError(e), "err");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={working ? undefined : onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>删除 {entries.length} 个条目</h2>

        <p className="del-warn">
          ⚠ 此操作不可撤销 —— 条目会从密码库中永久移除。请先确认下列条目都是要删的。
        </p>

        <ul className="del-list">
          {shown.map((e) => (
            <li key={e.id}>
              <span className="t">{e.title || "(无标题)"}</span>
              <span className="s">{e.username || e.url || "—"}</span>
            </li>
          ))}
        </ul>

        {rest > 0 && (
          <button className="link del-more" onClick={() => setExpanded(true)}>
            还有 {rest} 条 —— 展开全部查看
          </button>
        )}

        <div className="del-confirm">
          <div className="del-confirm-lbl">确认操作</div>
          <input
            className="gate-input"
            autoFocus
            spellCheck={false}
            value={text}
            placeholder={`输入「${CONFIRM_WORD}」或当前库的主密码`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
            }}
          />
          <p className="del-hint">
            两种任选其一：手打 <b>「{CONFIRM_WORD}」</b>二字，或输入<b>主密码</b>
            （主密码会重新做一次 Argon2id 校验，更严谨）。
          </p>
        </div>

        <div className="modal-btns">
          <button onClick={onClose} disabled={working}>
            取消
          </button>
          <button
            className="danger"
            disabled={working || text.trim().length === 0}
            onClick={confirm}
          >
            {checking ? "校验主密码…" : busy ? "删除中…" : `确认删除 ${entries.length} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}
