// @意图#R982(2026-11-25): 手动 API key 服务商「从电脑发」的转发分支（模块独立，官方 official.mjs 只在一处入口调它）。
// 与官方 prepare 的区别：官方用占位凭据＋换真令牌＋地址白名单；手动 pi 已用真实 key 构造带鉴权请求（key 在 headers 里），
// 这里**不换鉴权**原样转发。key 不落盘：不写配置、不记含 key 的日志（只记 host）。SSRF 校验沿用服务端 checkBaseUrl 口径（https、非内网）。
import { lookup as dnsLookup } from "node:dns/promises";

/** 手动服务商 provider 前缀：piProviderId = hub_<providerId>（非官方 id），据此走 manual 路径（其余非官方 id 仍按官方白名单拦） */
export const MANUAL_PREFIX = "hub_";
export const isManualProvider = (provider) => typeof provider === "string" && provider.startsWith(MANUAL_PREFIX);

/** 连接相关的头由本机 fetch 自算，不透传；鉴权（authorization / x-api-key / cookie）原样透传——已是真 key，不换、不改指纹 */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization"]);

class ManualError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const v4 = (ip) => {
  const m = ip.split(".");
  if (m.length !== 4) return null;
  const b = m.map(Number);
  return b.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? b : null;
};
const v4num = (b) => ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
/** 内网/本机/保留段（与服务端 net-guard 一致；198.18.0.0/15 是 Clash fake-ip 段，不拦） */
const V4_BLOCK = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 0, 2, 0, 24], [192, 168, 0, 0, 16],
  [198, 51, 100, 0, 24], [203, 0, 113, 0, 24], [224, 0, 0, 0, 4], [240, 0, 0, 0, 4],
];
const isPrivateV4 = (b) => V4_BLOCK.some(([b0, b1, b2, b3, prefix]) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (v4num(b) & mask) === (v4num([b0, b1, b2, b3]) & mask);
});

/** IP 字面（v4 点分 / v6 含冒号，可带 []）是否内网/本机/保留；非 IP 返回 false（交给域名检查） */
export function isPrivateIp(raw) {
  const ip = String(raw).replace(/^\[|\]$/g, "").toLowerCase();
  const b = v4(ip);
  if (b) return isPrivateV4(b);
  if (!ip.includes(":")) return false;
  if (ip === "::1" || ip === "::") return true; // 本机 / 未指定
  if (/^f[cd]/.test(ip)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(ip)) return true; // 链路本地 fe80::/10
  if (/^ff/.test(ip)) return true; // 组播 ff00::/8
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) { const m = v4(mapped[1]); return m ? isPrivateV4(m) : true; }
  return false;
}

/** 是否 IP 字面（决定要不要走 DNS 解析检查） */
const isIpLiteral = (host) => {
  const h = host.replace(/^\[|\]$/g, "");
  return v4(h) !== null || h.includes(":");
};

/** 内网域名（本机/内网后缀），字面直接拦 */
const isPrivateHostName = (host) => host === "localhost"
  || [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".private", ".intranet", ".home.arpa"].some((s) => host.endsWith(s));

const defaultResolve = (host) => dnsLookup(host, { all: true });

/** 域名解析全部地址，任一内网/保留就拦（防域名指向内网）；解析失败也拦 */
async function assertPublicHost(host, resolve) {
  let addrs;
  try { addrs = await resolve(host); } catch { throw new ManualError("blocked", `地址解析失败：${host}`); }
  for (const a of addrs ?? []) {
    const ip = typeof a === "string" ? a : a?.address;
    if (ip && isPrivateIp(ip)) throw new ManualError("blocked", `地址不允许：${host}`);
  }
}

/**
 * 把服务器转来的手动服务商请求改成可原样转发的 {url, init}：
 * https、无账号密码、端口空或 443；host 非内网（字面 + 域名 DNS 解析）；headers 原样透传（真 key），去掉连接相关的头。
 * 不换鉴权、不读/不写本机凭据、不改指纹、key 不落盘。
 */
export async function prepareManual(msg, resolve = defaultResolve) {
  if (!isManualProvider(msg.provider)) throw new ManualError("unknown", "不是手动服务商");
  let url;
  try { url = new URL(String(msg.url)); } catch { throw new ManualError("blocked", "地址格式不对"); }
  const host = url.hostname.toLowerCase();
  const okProto = url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443");
  if (!okProto) throw new ManualError("blocked", `地址不允许：${url.host || String(msg.url)}`);
  if (isPrivateHostName(host) || isPrivateIp(host)) throw new ManualError("blocked", `地址不允许：${host}`);
  if (!isIpLiteral(host)) await assertPublicHost(host, resolve);
  const headers = {};
  for (const pair of Array.isArray(msg.headers) ? msg.headers : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    const k = pair[0].toLowerCase();
    if (!HOP_HEADERS.has(k)) headers[k] = pair[1];
  }
  const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
  const body = typeof msg.body === "string" && method !== "GET" && method !== "HEAD" ? Buffer.from(msg.body, "base64") : undefined;
  return { url: url.href, init: { method, headers, body, redirect: "manual" } };
}
