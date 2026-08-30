import type { Hop } from "./types";

export interface ParsedTrace {
  target?: string;
  targetIp?: string;
  hops: Hop[];
}

const V4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const V6_RE = /^[0-9a-fA-F:]{3,}$/;

function isIpToken(t: string): boolean {
  if (V4_RE.test(t)) return t.split(".").every((o) => Number(o) <= 255);
  return t.includes(":") && V6_RE.test(t);
}

/**
 * traceroute / traceroute6 / Windows tracert / mtr --report の
 * 貼り付けテキストをゆるくパースする。
 */
export function parseTraceText(text: string): ParsedTrace {
  const result: ParsedTrace = { hops: [] };
  const byTtl = new Map<number, Hop>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    // ヘッダ行
    let m = line.match(/traceroute6? to (\S+) \(([^)]+)\)/);
    if (m) {
      result.target = m[1];
      result.targetIp = m[2];
      continue;
    }
    m = line.match(/Tracing route to (\S+)(?: \[([^\]]+)\])?/i);
    if (m) {
      result.target = m[1];
      result.targetIp = m[2];
      continue;
    }

    // mtr --report:  "  3.|-- 203.0.113.1   0.0%  10  1.2  1.5  1.1  2.0  0.3"
    m = line.match(/^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+\d+\s+([\d.]+)\s+([\d.]+)/);
    if (m) {
      const ttl = Number(m[1]);
      const hostTok = m[2];
      const timedOut = hostTok === "???";
      byTtl.set(ttl, {
        ttl,
        ip: timedOut ? null : isIpToken(hostTok) ? hostTok : null,
        hostname: !timedOut && !isIpToken(hostTok) ? hostTok : undefined,
        rtt: timedOut ? null : Number(m[5]), // Avg
      });
      continue;
    }

    // 通常のホップ行 (traceroute / tracert 共通のゆるい解釈)
    m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const ttl = Number(m[1]);
    const rest = m[2].trim();

    if (
      /^(\*[\s*]*)$/.test(rest) ||
      /request timed out/i.test(rest) ||
      rest.includes("要求がタイムアウトしました")
    ) {
      if (!byTtl.has(ttl)) byTtl.set(ttl, { ttl, ip: null, rtt: null });
      continue;
    }

    // IP を探す: "host (1.2.3.4)" / "host [1.2.3.4]" / 裸の IP トークン
    let ip: string | null = null;
    let hostname: string | undefined;
    const paren = rest.match(/(\S+)\s+[([]([0-9a-fA-F.:]+)[)\]]/);
    if (paren && isIpToken(paren[2])) {
      ip = paren[2];
      if (paren[1] !== ip && !/^[\d.]+$/.test(paren[1])) hostname = paren[1];
    } else {
      const tokens = rest.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i].replace(/^[([]|[)\]]$/g, "");
        if (isIpToken(tok)) {
          ip = tok;
          const prev = tokens[i - 1];
          if (
            prev &&
            prev !== "*" &&
            prev.toLowerCase() !== "ms" &&
            !/^[\d.<]+$/.test(prev) &&
            !isIpToken(prev)
          ) {
            hostname = prev;
          }
          break;
        }
      }
      // tracert は "12 ms ... hostname" のようにホスト名だけの場合もある
      if (!ip && !hostname) {
        const last = tokens[tokens.length - 1];
        if (last && last !== "*" && last.toLowerCase() !== "ms" && !/^[\d.<]+$/.test(last)) {
          hostname = last;
        }
      }
    }

    const rtts = [...rest.matchAll(/(<?)(\d+(?:\.\d+)?)\s*ms/g)].map((r) => Number(r[2]));
    const rtt = rtts.length ? Math.min(...rtts) : null;

    if (ip !== null || hostname !== undefined || rtt !== null) {
      const existing = byTtl.get(ttl);
      if (!existing || existing.ip === null) {
        byTtl.set(ttl, { ttl, ip, hostname, rtt });
      }
    }
  }

  result.hops = [...byTtl.values()].sort((a, b) => a.ttl - b.ttl);
  return result;
}
