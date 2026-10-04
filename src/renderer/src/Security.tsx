import { useState } from "react";
import { api, cleanError } from "./api";

/**
 * 三个「主密码级」操作弹窗。放在一个文件里, 是因为它们共享同一套安全约定:
 *
 *   破坏性由低到高:  改主密码  <  清空全部  <  重置密码库
 *   数据结局        : 全保留      条目没了     条目 + 主密码都换
 *
 * 越危险的操作确认门槛越高 —— 重置要手打确认词 (因为它连主密码都换掉,
 * 事后没有任何"用旧密码看一眼"的可能), 清空要输真主密码 (走一次真实的
 * Argon2id 重新派生校验, 不是比对前端的字符串)。
 *
 * 为什么不用 window.confirm: 那不是"防误触", 只是"防走神"。密码管理器里
 * 一次误点可能意味着几年的数据, 值得让人多花三秒。
 */

/** 改主密码 —— 还记得旧密码, 只想换一个。条目密文一条都不动。 */
export function ChangePasswordModal(props: {
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [oldPw, setOldPw] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint, setHint] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = pw2.length > 0 && pw !== pw2;
  const tooShort = pw.length > 0 && pw.length < 8;
  const sameAsOld = pw.length > 0 && pw === oldPw;
  const ready = oldPw.length > 0 && pw.length >= 8 && pw === pw2 && pw !== oldPw;

  async function submit() {
    if (!ready || busy) return;
    setErr("");
    setBusy(true);
    try {
      await api.vault.changePassword(oldPw, pw, hint.trim());
      props.onDone(
        "主密码已更换。所有条目原样保留 —— 换的只是包裹密钥的那一层，密文一条都没动。",
      );
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={busy ? undefined : props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>修改主密码</h2>

        <p className="sec-note">
          新旧密码都会走一次 Argon2id 派生校验。改完之后，<b>数据一条不丢</b> ——
          只会用新密码重新包裹那把打开数据的钥匙。
        </p>

        <label className="sec-field">
          <span>当前主密码</span>
          <input
            className="gate-input"
            type="password"
            autoFocus
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>新主密码（至少 8 位）</span>
          <input
            className="gate-input"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>再输入一次新主密码</span>
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

        <label className="sec-field">
          <span>新密码提示（可选，明文存在库文件头）</span>
          <input
            className="gate-input"
            type="text"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
          />
        </label>

        {tooShort && <p className="sec-err">✕ 新主密码至少 8 位</p>}
        {mismatch && <p className="sec-err">✕ 两次输入的新主密码不一致</p>}
        {sameAsOld && <p className="sec-err">✕ 新主密码与当前主密码相同</p>}
        {err && <p className="sec-err">✕ {err}</p>}

        <div className="modal-btns">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={!ready || busy} onClick={submit}>
            {busy ? "重新派生密钥…" : "更换主密码"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 重置密码库 —— 忘记主密码时唯一的出路。
 *
 * 必须把话说透: 零知识加密没有后门, 旧数据在数学上不可恢复。这里不是
 * "找回密码", 是"放弃旧密文、重新开一个空库"。所以:
 *   1. 大段红色警告摆在最前面;
 *   2. 必须手打「重置」二字 (光点按钮太容易);
 *   3. 默认保留旧库备份 —— 万一想起旧密码还能回去。
 */
export function ResetVaultModal(props: {
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const CONFIRM_WORD = "重置";
  const [word, setWord] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [hint, setHint] = useState("");
  const [keepBackup, setKeepBackup] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const ready =
    word.trim() === CONFIRM_WORD && pw.length >= 8 && pw === pw2;

  async function submit() {
    if (!ready || busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api.vault.reset(pw, hint.trim(), keepBackup);
      props.onDone(
        r.backupPath
          ? `主密码已重置，密码库现在是空的。\n\n旧库已备份到：\n${r.backupPath}\n想找回旧数据时，用当时的密码打开这个文件。`
          : "主密码已重置，密码库现在是空的。（未保留旧库备份）",
      );
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={busy ? undefined : props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>重置主密码</h2>

        <div className="sec-danger">
          <b>零知识加密没有后门，忘记主密码后旧数据无法恢复。</b>
          <span>
            重置会先把当前库另存为一份带时间戳的 .bak 备份，再用新主密码生成
            一个<b>全新的空库</b>覆盖原文件。旧条目仍留在备份里，但只有想起
            旧密码才能打开它。
          </span>
          <span>
            如果你其实只是<b>想换密码</b>（还记得旧的那个），请先解锁再走
            「修改主密码」，别用这里 —— 那个不会丢数据。
          </span>
        </div>

        <label className="sec-field">
          <span>新主密码（至少 8 位）</span>
          <input
            className="gate-input"
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>再输入一次新主密码</span>
          <input
            className="gate-input"
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </label>

        <label className="sec-field">
          <span>新密码提示（可选）</span>
          <input
            className="gate-input"
            type="text"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
          />
        </label>

        <label className="sec-check">
          <input
            type="checkbox"
            checked={keepBackup}
            onChange={(e) => setKeepBackup(e.target.checked)}
          />
          重置前把旧库另存为 .bak 备份（强烈建议保留）
        </label>

        <label className="sec-field">
          <span>
            请输入「{CONFIRM_WORD}」二字确认
          </span>
          <input
            className="gate-input"
            spellCheck={false}
            placeholder={CONFIRM_WORD}
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>

        {pw.length > 0 && pw.length < 8 && <p className="sec-err">✕ 新主密码至少 8 位</p>}
        {pw2.length > 0 && pw !== pw2 && <p className="sec-err">✕ 两次输入的新主密码不一致</p>}
        {err && <p className="sec-err">✕ {err}</p>}

        <div className="modal-btns">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="danger" disabled={!ready || busy} onClick={submit}>
            {busy ? "重建空库…" : "确认重置"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 清空全部条目 —— 主密码保留, 只是把条目清掉。
 *
 * 与重置的区别: 重置换的是**整把钥匙** (旧密文全废); 清空只是把库里的
 * 条目删干净, 主密码还能用。因为可逆 (动手前会强制落一份快照), 门槛
 * 定在"输入主密码"这一档。
 */
export function ClearAllModal(props: {
  count: number;
  onClose: () => void;
  onDone: (removed: number) => void;
}) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pw || busy) return;
    setErr("");
    setBusy(true);
    try {
      props.onDone(await api.vault.clearAll(pw));
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask" onMouseDown={busy ? undefined : props.onClose}>
      <div className="modal fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h2>清空全部 {props.count} 个条目</h2>

        <div className="sec-danger">
          <b>主密码不变，但库里的条目会被全部移除。</b>
          <span>
            这一步是<b>可逆的</b>：清空之前会自动落一份快照到备份目录，
            随时能从「设置 → 数据 → 库文件快照」退回来。
          </span>
        </div>

        <label className="sec-field">
          <span>输入当前主密码以确认（会重新做一次 Argon2id 校验）</span>
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

        {err && <p className="sec-err">✕ {err}</p>}

        <div className="modal-btns">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="danger" disabled={!pw || busy} onClick={submit}>
            {busy ? "校验主密码…" : `确认清空 ${props.count} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}
