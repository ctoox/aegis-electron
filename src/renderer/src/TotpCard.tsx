import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/** TOTP 动态码卡: 6 位码 + 环形倒计时 (每 30s 自动换, 剩余 5s 变红). */
export function TotpCard(props: { secret: string }) {
  const [view, setView] = useState<{
    code: string;
    remaining: number;
    period: number;
    error?: string;
  }>({ code: "", remaining: 0, period: 30 });
  const tick = useRef<number | null>(null);

  // 拿码: 进入/密钥变化/倒计时归零时重新计算
  useEffect(() => {
    let alive = true;
    const fetchCode = async () => {
      const v = await api.totp.code(props.secret);
      if (alive) setView(v);
    };
    fetchCode();
    tick.current = window.setInterval(async () => {
      setView((v) => {
        if (v.remaining <= 1) {
          fetchCode();
          return { ...v, remaining: v.period }; // 立刻重置, 避免闪烁
        }
        return { ...v, remaining: v.remaining - 1 };
      });
    }, 1000);
    return () => {
      alive = false;
      if (tick.current) window.clearInterval(tick.current);
    };
  }, [props.secret]);

  if (view.error) {
    return (
      <div className="field">
        <div className="grow">
          <div className="lbl">动态验证码 (TOTP)</div>
          <div className="val" style={{ color: "var(--danger)" }}>
            {view.error}
          </div>
        </div>
      </div>
    );
  }

  const R = 15;
  const C = 2 * Math.PI * R;
  const frac = view.period ? view.remaining / view.period : 0;
  const urgent = view.remaining <= 5;

  return (
    <div className="field">
      <div className="grow">
        <div className="lbl">动态验证码 (TOTP)</div>
        <div className="totp-line">
          <span className="totp-code">{view.code.replace(/(\d{3})(\d{3})/, "$1 $2")}</span>
          <svg className="totp-ring" width="38" height="38" viewBox="0 0 38 38">
            <circle cx="19" cy="19" r={R} fill="none" stroke="var(--border)" strokeWidth="3" />
            <circle
              cx="19" cy="19" r={R} fill="none"
              stroke={urgent ? "var(--danger)" : "var(--accent)"}
              strokeWidth="3" strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - frac)}
              transform="rotate(-90 19 19)"
              style={{ transition: "stroke-dashoffset 0.9s linear" }}
            />
            <text x="19" y="19" textAnchor="middle" dominantBaseline="central"
              className="totp-sec-num" fill={urgent ? "var(--danger)" : "var(--text-2)"}>
              {view.remaining}
            </text>
          </svg>
        </div>
      </div>
      <div className="ops">
        <button className="iconbtn" onClick={() => navigator.clipboard?.writeText(view.code)}>⧉</button>
      </div>
    </div>
  );
}
