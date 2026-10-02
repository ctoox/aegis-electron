import { useState } from "react";
import { api, cleanError } from "./api";

/** 主密码门: 无库 → 创建 (双输入+提示语); 有库 → 解锁. */
export function Gate(props: {
  mode: "create" | "unlock";
  hint: string;
  onDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint, setHint] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const isCreate = props.mode === "create";

  async function submit() {
    setErr("");
    setBusy(true);
    try {
      if (isCreate) {
        if (pw.length < 8) throw new Error("主密码至少 8 位");
        if (pw !== pw2) throw new Error("两次输入的密码不一致");
        await api.vault.create(pw, hint.trim());
      } else {
        await api.vault.unlock(pw);
      }
      props.onDone();
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form
        className="gate-card fade-in"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <div className="gate-logo">🛡️</div>
        <h1>{isCreate ? "创建密码库" : "解锁密码库"}</h1>
        <p className="gate-sub">
          {isCreate
            ? "主密码是唯一的钥匙：Argon2id 派生密钥 + AES-256-GCM 加密，没有找回机制"
            : "输入主密码解锁（密钥只存在于本进程内存，锁定即擦除）"}
        </p>

        <input
          className="gate-input"
          type="password"
          placeholder="主密码"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
        {isCreate && (
          <>
            <input
              className="gate-input"
              type="password"
              placeholder="再输入一次"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
            <input
              className="gate-input"
              type="text"
              placeholder="密码提示（可选，明文存在库文件头）"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
          </>
        )}
        {!isCreate && props.hint && (
          <p className="gate-hint">提示：{props.hint}</p>
        )}
        {err && <p className="gate-err">✕ {err}</p>}

        <button className="gate-btn" type="submit" disabled={busy}>
          {busy ? "Argon2id 计算中…" : isCreate ? "创建并进入" : "解锁"}
        </button>
      </form>
    </div>
  );
}
