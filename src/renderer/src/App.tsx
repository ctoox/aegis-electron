import { useState } from "react";

declare global {
  interface Window {
    api: { greet: (name: string) => Promise<string> };
  }
}

// 冒烟页: 与 Tauri 版同 UI 同交互, 方便两版对比.
export default function App() {
  const [reply, setReply] = useState("");

  async function ping() {
    try {
      const msg = await window.api.greet("神盾");
      setReply(msg);
    } catch (e) {
      setReply(`IPC 失败: ${e}`);
    }
  }

  return (
    <main className="hero">
      <div className="shield">🛡️</div>
      <h1>神盾 Aegis (Electron)</h1>
      <p className="sub">Electron · React · TypeScript 脚手架已就绪</p>
      <button onClick={ping}>测试后端连接</button>
      {reply && <p className="reply">{reply}</p>}
    </main>
  );
}
