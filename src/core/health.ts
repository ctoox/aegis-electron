/**
 * 密码健康检查 (对照 Bitwarden Vault Health 六报表).
 *
 * 纯本地四类 (无网络):
 *   1. weak     弱密码    strengthBits < 阈值 (默认 40 bit ≈ "fair" 下限)
 *   2. reused   重复使用  同一条密码出现在 ≥2 个条目
 *   3. http     明文站点  条目 URL 是 http:// (非 https)
 *   4. no2fa    缺两步验证 条目有 URL 但没配 TOTP (粗判, 不做站点指纹库)
 * 联网一类:
 *   5. pwned    已泄露    HIBP k-匿名查询命中 (可关闭 / 离线降级)
 *
 * 本地部分 (analyzeLocal) 不依赖网络, 渲染层侧栏的健康分也用它;
 * 联网部分通过注入 BreachChecker 完成, 便于单测与降级.
 */
import type { Entry } from "./types";
// 只从 strength.ts 取纯算法 —— 渲染层要 import 本模块, 不能把 node:crypto 拖进去
import { strengthBits, strengthOf, WEAK_BITS } from "./strength";
import type { BreachChecker } from "./hibp";

export type IssueKind = "weak" | "reused" | "pwned" | "http" | "no2fa";

export const ISSUE_META: Record<
  IssueKind,
  { label: string; hint: string; icon: string; severity: "high" | "mid" | "low" }
> = {
  pwned: { label: "已泄露", hint: "该密码出现在公开泄露库中，请立即更换", icon: "☣", severity: "high" },
  weak: { label: "弱密码", hint: "熵值过低，可被暴力破解", icon: "⚠", severity: "high" },
  reused: { label: "重复使用", hint: "多个条目共用同一条密码，一处泄露处处失守", icon: "⧉", severity: "mid" },
  http: { label: "明文 HTTP", hint: "站点未启用 HTTPS，密码可能被中间人截获", icon: "⇄", severity: "mid" },
  no2fa: { label: "未启用两步验证", hint: "已登录的站点建议补一个 TOTP", icon: "○", severity: "low" },
};

export interface HealthIssue {
  entryId: string;
  title: string;
  username: string;
  kind: IssueKind;
  /** 补充说明, 如重复组的其他条目 / 泄露次数 */
  detail: string;
}

export interface ReuseGroup {
  /** 该密码被几个条目使用 */
  count: number;
  /** 参与条目的 id */
  ids: string[];
  titles: string[];
  /** 强度 (给 UI 展示) */
  strength: string;
}

export interface LocalHealth {
  /** 参与统计的条目数 (有密码的) */
  scored: number;
  weak: number;
  reused: number;
  /** 涉及重复的条目数 (不是重复组数) */
  reusedEntries: number;
  http: number;
  no2fa: number;
  issues: HealthIssue[];
  reuseGroups: ReuseGroup[];
  /** 0–100, 越高越健康 */
  score: number;
  /** 强度分布 */
  distribution: { good: number; fair: number; weak: number; none: number };
}

export interface HealthReport extends LocalHealth {
  pwned: number;
  /** 实际做了 HIBP 检查的密码数 (去重后) */
  breachChecked: number;
  /** 泄露检测失败时的原因 (离线/超时); 有值时 pwned 不参与计分 */
  breachError?: string;
  /** 泄露检测是否被用户关闭 */
  breachDisabled: boolean;
  generatedAt: number;
}

// 弱密码阈值 WEAK_BITS 定义在 ./strength.ts, 这里 re-export 供既有调用点使用
export { WEAK_BITS };

/**
 * 健康分权重. 每一项按「涉及条目数 / 总条目数」的比例扣分, 权重体现危害程度:
 * 泄露 > 弱 > 明文 HTTP > 重复 > 缺 2FA
 */
const WEIGHTS: Record<IssueKind, number> = {
  pwned: 55,
  weak: 30,
  http: 10,
  reused: 18,
  no2fa: 5,
};

function isHttp(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith("http://");
}

/** 纯本地体检 (无网络), 侧栏健康分与设置页都用它 */
export function analyzeLocal(entries: Entry[]): LocalHealth {
  const withPw = entries.filter((e) => e.password);
  const distribution = { good: 0, fair: 0, weak: 0, none: 0 };

  // ---- 1. 弱密码 + 强度分布 ----
  const issues: HealthIssue[] = [];
  const weakIds = new Set<string>();
  for (const e of entries) {
    const s = strengthOf(e.password);
    distribution[s]++;
    if (!e.password) continue;
    if (strengthBits(e.password) < WEAK_BITS) {
      weakIds.add(e.id);
      issues.push({
        entryId: e.id,
        title: e.title || "(无标题)",
        username: e.username,
        kind: "weak",
        detail: `约 ${strengthBits(e.password)} bit 熵（低于 ${WEAK_BITS} bit）`,
      });
    }
  }

  // ---- 2. 重复密码 (按密码原文分组) ----
  const byPw = new Map<string, Entry[]>();
  for (const e of withPw) {
    const arr = byPw.get(e.password);
    if (arr) arr.push(e);
    else byPw.set(e.password, [e]);
  }
  const reuseGroups: ReuseGroup[] = [];
  const reusedIds = new Set<string>();
  for (const [, group] of byPw) {
    if (group.length < 2) continue;
    reuseGroups.push({
      count: group.length,
      ids: group.map((e) => e.id),
      titles: group.map((e) => e.title || "(无标题)"),
      strength: strengthOf(group[0].password),
    });
    for (const e of group) {
      reusedIds.add(e.id);
      issues.push({
        entryId: e.id,
        title: e.title || "(无标题)",
        username: e.username,
        kind: "reused",
        detail: `与另外 ${group.length - 1} 个条目共用同一条密码`,
      });
    }
  }
  reuseGroups.sort((a, b) => b.count - a.count);

  // ---- 3. 明文 HTTP ----
  const httpIds = new Set<string>();
  for (const e of entries) {
    if (!isHttp(e.url)) continue;
    httpIds.add(e.id);
    issues.push({
      entryId: e.id,
      title: e.title || "(无标题)",
      username: e.username,
      kind: "http",
      detail: e.url,
    });
  }

  // ---- 4. 有站点却没 TOTP (粗判: 只对 login 且 url 非空生效) ----
  const no2faIds = new Set<string>();
  for (const e of entries) {
    if (e.type !== "login" || !e.url || !e.password) continue;
    if (e.extra?.totp) continue;
    no2faIds.add(e.id);
    issues.push({
      entryId: e.id,
      title: e.title || "(无标题)",
      username: e.username,
      kind: "no2fa",
      detail: "该站点未配置 TOTP",
    });
  }

  const n = Math.max(withPw.length, 1);
  const penalty =
    (weakIds.size * WEIGHTS.weak +
      reusedIds.size * WEIGHTS.reused +
      httpIds.size * WEIGHTS.http +
      no2faIds.size * WEIGHTS.no2fa) /
    n;
  const score = clamp(Math.round(100 - penalty), 0, 100);

  return {
    scored: withPw.length,
    weak: weakIds.size,
    reused: reuseGroups.length,
    reusedEntries: reusedIds.size,
    http: httpIds.size,
    no2fa: no2faIds.size,
    issues,
    reuseGroups,
    score,
    distribution,
  };
}

/**
 * 完整体检: 本地 + HIBP 泄露检测.
 * 断网 / 超时 → 不抛错, 把原因放进 breachError, 分数按「已检测部分」算.
 */
export async function analyzeWithBreach(
  entries: Entry[],
  opts: { checker?: BreachChecker; enabled?: boolean } = {},
): Promise<HealthReport> {
  const local = analyzeLocal(entries);
  const enabled = opts.enabled ?? true;
  const base: HealthReport = {
    ...local,
    pwned: 0,
    breachChecked: 0,
    breachDisabled: !enabled,
    generatedAt: Date.now(),
  };
  if (!enabled || !opts.checker) return base;

  const passwords = [...new Set(entries.filter((e) => e.password).map((e) => e.password))];
  if (passwords.length === 0) return base;

  let hits: Map<string, number>;
  try {
    hits = await opts.checker(passwords);
  } catch (e) {
    return { ...base, breachError: e instanceof Error ? e.message : String(e) };
  }

  const pwnedIds = new Set<string>();
  const issues = [...local.issues];
  for (const e of entries) {
    const n = hits.get(e.password);
    if (!n) continue;
    pwnedIds.add(e.id);
    issues.push({
      entryId: e.id,
      title: e.title || "(无标题)",
      username: e.username,
      kind: "pwned",
      detail: `在泄露库中出现 ${n.toLocaleString("zh-CN")} 次`,
    });
  }

  const denom = Math.max(local.scored, 1);
  const penalty =
    (local.weak * WEIGHTS.weak +
      local.reusedEntries * WEIGHTS.reused +
      local.http * WEIGHTS.http +
      local.no2fa * WEIGHTS.no2fa +
      pwnedIds.size * WEIGHTS.pwned) /
    denom;

  // 严重项排前面
  const order: Record<IssueKind, number> = { pwned: 0, weak: 1, reused: 2, http: 3, no2fa: 4 };
  issues.sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));

  return {
    ...base,
    pwned: pwnedIds.size,
    breachChecked: passwords.length,
    issues,
    score: clamp(Math.round(100 - penalty), 0, 100),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 按类别统计问题条目 (UI 的六个卡片用) */
export function countsByKind(r: LocalHealth): Record<IssueKind, number> {
  const out: Record<IssueKind, number> = { pwned: 0, weak: 0, reused: 0, http: 0, no2fa: 0 };
  for (const i of r.issues) out[i.kind]++;
  return out;
}

export function scoreGrade(score: number): "excellent" | "good" | "fair" | "poor" {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 55) return "fair";
  return "poor";
}
