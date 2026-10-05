import { useState } from "react";
import type { Entry } from "../../core/types";
import { api, cleanError } from "./api";
import { GeneratorModal, type GenDefaults } from "./GeneratorModal";

/** 新增/编辑条目表单. */
export function EntryModal(props: {
  initial?: Entry | null;
  onDone: () => void;
  onClose: () => void;
  /** 透传给生成器弹窗的默认参数 (来自设置页) */
  genDefaults?: GenDefaults;
}) {
  const editing = props.initial ?? null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState(editing?.password ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [totp, setTotp] = useState(editing?.extra?.totp ?? "");
  const [err, setErr] = useState("");
  const [genOpen, setGenOpen] = useState(false);
  // ★ 默认遮罩（2026-10-05）。编辑既有条目时这两个框里装的就是**真实凭据**，
  //   而这个弹窗会被截屏、被旁人瞄一眼、被录屏 —— 明文摆着没有任何收益。
  //   要点开确认再点 👁，是"每次都要重新同意"。
  const [showPw, setShowPw] = useState(false);
  const [showTotp, setShowTotp] = useState(false);

  async function submit() {
    if (!title.trim()) {
      setErr("标题不能为空");
      return;
    }
    try {
      const extra = { ...(editing?.extra ?? {}), totp: totp.trim() };
      const patch = {
        title: title.trim(),
        username: username.trim(),
        password,
        url: url.trim(),
        notes,
        extra,
      };
      if (editing) await api.vault.update(editing.id, patch);
      else await api.vault.add(patch);
      props.onDone();
    } catch (e) {
      setErr(cleanError(e));
    }
  }

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? "编辑条目" : "新增条目"}</h2>
        {genOpen && (
          <GeneratorModal
            defaults={props.genDefaults}
            onUse={(pw) => setPassword(pw)}
            onClose={() => setGenOpen(false)}
          />
        )}
        <input
          className="gate-input"
          placeholder="标题 *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <input
          className="gate-input"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <div className="pw-line">
          <input
            className="gate-input grow"
            placeholder="密码"
            type={showPw ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="iconbtn"
            title={showPw ? "隐藏密码" : "显示密码"}
            aria-label={showPw ? "隐藏密码" : "显示密码"}
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? "🙈" : "👁"}
          </button>
          <button className="gen-btn" onClick={() => setGenOpen(true)}>
            🪄 生成
          </button>
        </div>
        <input
          className="gate-input"
          placeholder="网址"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="pw-line">
          <input
            className="gate-input grow"
            placeholder="TOTP 密钥（可选，Base32，如 JBSWY3DPEHPK3PXP）"
            type={showTotp ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
          />
          <button
            className="iconbtn"
            title={showTotp ? "隐藏密钥" : "显示密钥"}
            aria-label={showTotp ? "隐藏密钥" : "显示密钥"}
            onClick={() => setShowTotp((v) => !v)}
          >
            {showTotp ? "🙈" : "👁"}
          </button>
        </div>
        <textarea
          className="gate-input"
          placeholder="备注"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {err && <p className="gate-err">✕ {err}</p>}
        <div className="modal-btns">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" onClick={submit}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
