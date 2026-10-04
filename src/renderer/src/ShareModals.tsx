import { useState } from "react";
import type { EntryWithStrength } from "../../core/types";
import { api, cleanError, type ShareCandidate } from "./api";
import type { ToastKind } from "./Toast";

/**
 * 加密分享包: 把选中的几条条目打包成**自包含的密文文件**, 用独立口令保护。
 *
 * 与"导出为 CSV/JSON"的根本区别: 那些是明文, 导出即泄露; 分享包是密文,
 * 且用的是**独立的随机密钥** —— 即使分享口令被猜破, 也只暴露这一个包里的
 * 这几条, 连带不到主库、主密码和其余条目。
 *
 * 所以 UI 上要把这件事说明白, 否则用户会以为"导出"都一个样。
 */
const TYPE_LABEL: Record<string, string> = {
  login: "登录",
  note: "笔记",
  bank: "银行",
  id: "证件",
};

export function ShareExportModal(props: {
  /** 用户在列表里勾选的条目 (可能为空 → 默认分享全部) */
  selected: EntryWithStrength[];
  all: EntryWithStrength[];
  onClose: () => void;
  notify: (text: string, kind?: ToastKind) => void;
}) {
  const [useAll, setUseAll] = useState(props.selected.length === 0);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [title, setTitle] = useState("");
  const [sender, setSender] = useState("");
  const [note, setNote] = useState("");
  const [hint, setHint] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const target = useAll ? props.all : props.selected;
  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ready = target.length > 0 && pw.length >= 8 && pw === pw2;

  async function submit() {
    if (!ready || busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api.share.export(
        target.map((e) => e.id),
        { password: pw, title, sender, note, hint },
      );
      if (!r) {
        setBusy(false);
        return; // 用户在保存对话框里取消了
      }
      props.notify(
        `已导出 ${r.count} 条到 ${r.path}（内容指纹 ${r.fingerprint.slice(0, 16)}…）`,
        "ok",
      );
      props.onClose();
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={busy ? undefined : props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>导出加密分享包</h2>

        <p className="sec-note">
          分享包本身是<b>密文</b>，用<b>独立口令</b>保护 —— 接收方只需要这个口令，
          拿不到你的主密码，也看不到没被选中的条目。把口令和文件<b>分开</b>发出去。
        </p>

        <div className="share-scope">
          {props.selected.length > 0 && (
            <label>
              <input
                type="radio"
                checked={!useAll}
                onChange={() => setUseAll(false)}
              />
              只分享选中的 {props.selected.length} 条
            </label>
          )}
          <label>
            <input type="radio" checked={useAll} onChange={() => setUseAll(true)} />
            分享全部 {props.all.length} 条
          </label>
        </div>

        <label className="sec-field">
          <span>包标题（明文可见，让接收方知道这是什么）</span>
          <input
            className="gate-input"
            type="text"
            placeholder="例如：网络设备账号"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>分享口令（至少 8 位，与主密码无关）</span>
          <input
            className="gate-input"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>再输入一次分享口令</span>
          <input
            className="gate-input"
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>

        <div className="sec-2col">
          <label className="sec-field">
            <span>署名（可选）</span>
            <input
              className="gate-input"
              type="text"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </label>
          <label className="sec-field">
            <span>口令提示（可选）</span>
            <input
              className="gate-input"
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
          </label>
        </div>

        <label className="sec-field">
          <span>给接收方的一句话（可选）</span>
          <input
            className="gate-input"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {tooShort && <p className="sec-err">✕ 分享口令至少 8 位</p>}
        {mismatch && <p className="sec-err">✕ 两次输入的分享口令不一致</p>}
        {err && <p className="sec-err">✕ {err}</p>}

        <div className="modal-btns">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={!ready || busy} onClick={submit}>
            {busy ? "Argon2id 加密中…" : `导出 ${target.length} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 导入分享包 —— 导入前先给用户看清楚"要进来什么"。
 *
 * 文件的明文元信息 (标题/署名/条目数/类型分布) 不需要口令就能读, 所以
 * 第一屏就能判断"这是不是我要的那个包"。输错口令只会得到一句"口令错误",
 * 不会泄漏任何内容。
 */
export function ShareImportModal(props: {
  candidate: ShareCandidate;
  onClose: () => void;
  onDone: (added: number, skipped: number, rekeyed: number) => void;
  notify: (text: string, kind?: ToastKind) => void;
}) {
  const { candidate, onClose, onDone } = props;
  const [pw, setPw] = useState("");
  const [forceNew, setForceNew] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const info = candidate.info;

  async function submit() {
    if (!pw || busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api.share.commitImport(candidate.doc, pw, {
        forceNewIds: forceNew,
      });
      onDone(r.added, r.skipped, r.rekeyed);
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  const typeText = Object.entries(info.type_counts)
    .map(([t, n]) => `${TYPE_LABEL[t] ?? t}×${n}`)
    .join("、");

  return (
    <div className="modal-mask" onMouseDown={busy ? undefined : onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>导入分享包</h2>

        <div className="imp-meta">
          <div>
            <span>文件</span>
            <b>{candidate.fileName}</b>
          </div>
          <div>
            <span>标题</span>
            <b>{info.title || "(未命名分享包)"}</b>
          </div>
          <div>
            <span>条目数</span>
            <b>
              {info.entry_count} 条{typeText ? `（${typeText}）` : ""}
            </b>
          </div>
          <div>
            <span>大小</span>
            <b>{(candidate.bytes / 1024).toFixed(1)} KB</b>
          </div>
          {info.sender && (
            <div>
              <span>来自</span>
              <b>{info.sender}</b>
            </div>
          )}
          {info.createdText && (
            <div>
              <span>生成时间</span>
              <b>{info.createdText}</b>
            </div>
          )}
        </div>

        {info.note && <p className="imp-line">说明：{info.note}</p>}
        {info.hint && <p className="imp-line">口令提示：{info.hint}</p>}

        <p className="sec-note">
          以上都是包里的<b>明文</b>元信息。条目内容仍然是密文，需要正确的分享
          口令才能解开 —— 这个口令不是你的主密码。
        </p>

        <label className="sec-field">
          <span>分享口令</span>
          <input
            className="gate-input"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>

        <label className="sec-check">
          <input
            type="checkbox"
            checked={forceNew}
            onChange={(e) => setForceNew(e.target.checked)}
          />
          全部作为新副本导入（给每条重新分配 ID，即使原来是同一个条目）
        </label>

        {err && <p className="sec-err">✕ {err}</p>}

        <div className="modal-btns">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={!pw || busy} onClick={submit}>
            {busy ? "Argon2id 校验中…" : `确认导入 ${info.entry_count} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 触发系统文件选择对话框, 选中并读出分享包的明文元信息 */
export async function pickShare(
  notify: (text: string, kind?: ToastKind) => void,
): Promise<ShareCandidate | null> {
  try {
    return await api.share.pickImport();
  } catch (e) {
    notify(cleanError(e), "err");
    return null;
  }
}
