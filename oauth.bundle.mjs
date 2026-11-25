// 自动生成，不要手改：node release/oauth-bundle.mjs（R912）
// 来源：@earendil-works/pi-ai@1.6.0（MIT License，作者 Mario Zechner，https://github.com/earendil-works/pi），只含官方套餐登录与刷新：kimi-coding.js、xai.js、github-copilot.js、openai-codex.js
// 输入文件 14 个，合并 sha256=f2de6927ea2833ea0253742eb6f80e9c02795bef86d6f20516b02bb7a56abae6（逐个见 release/oauth-bundle.lock.json）
/*
 * MIT License（pi-ai 的 package.json 声明；原文照录）
 * Copyright (c) Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// dist/utils/provider-env.js
var procEnvCache = null;
function getBunSandboxEnvValue(name) {
  if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
    return void 0;
  }
  if (procEnvCache === null) {
    procEnvCache = /* @__PURE__ */ new Map();
    try {
      const { readFileSync } = __require("node:fs");
      const data = readFileSync("/proc/self/environ", "utf-8");
      for (const entry of data.split("\0")) {
        const idx = entry.indexOf("=");
        if (idx > 0) {
          procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
        }
      }
    } catch {
    }
  }
  return procEnvCache.get(name);
}
function getProviderEnvValue(name, env) {
  return env?.[name] || (typeof process !== "undefined" ? process.env[name] : void 0) || getBunSandboxEnvValue(name) || void 0;
}

// dist/utils/sleep.js
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// dist/auth/oauth/device-code.js
var CANCEL_MESSAGE = "Login cancelled";
var TIMEOUT_MESSAGE = "Device flow timed out";
var SLOW_DOWN_TIMEOUT_MESSAGE = "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
var MINIMUM_INTERVAL_MS = 1e3;
var DEFAULT_POLL_INTERVAL_SECONDS = 5;
var SLOW_DOWN_INTERVAL_INCREMENT_MS = 5e3;
function abortableSleep(ms, signal, cancelMessage) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error(cancelMessage));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollOAuthDeviceCodeFlow(options) {
  const deadline = typeof options.expiresInSeconds === "number" ? Date.now() + options.expiresInSeconds * 1e3 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1e3));
  let slowDownResponses = 0;
  if (options.waitBeforeFirstPoll) {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
    }
  }
  while (Date.now() < deadline) {
    if (options.signal.aborted) {
      throw new Error(CANCEL_MESSAGE);
    }
    const result = await options.poll();
    if (result.status === "complete") {
      return result.value;
    }
    if (result.status === "failed") {
      throw new Error(result.message);
    }
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      intervalMs = typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0 ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1e3)) : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
  }
  throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}

// dist/auth/oauth/trusted-url.js
function trustedHttpUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value))
    return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

// dist/auth/oauth/kimi-coding.js
var CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
var DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
var DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
var DEFAULT_POLL_INTERVAL_SECONDS2 = 5;
var REQUEST_TIMEOUT_MS = 30 * 1e3;
var REFRESH_MAX_RETRIES = 3;
function getOauthHost() {
  const override = getProviderEnvValue("KIMI_CODE_OAUTH_HOST") || getProviderEnvValue("KIMI_OAUTH_HOST");
  return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}
function requestSignal(signal) {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}
function formUrlEncode(fields) {
  return new URLSearchParams(fields).toString();
}
async function readJson(response) {
  try {
    const json = await response.json();
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}
async function startDeviceAuthorization(oauthHost, signal) {
  const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: formUrlEncode({ client_id: CLIENT_ID }),
    signal: requestSignal(signal)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
  }
  const json = await readJson(response);
  const deviceCode = json?.device_code;
  const userCode = json?.user_code;
  const verificationUri = trustedHttpUrl(json?.verification_uri);
  const verificationUriComplete = trustedHttpUrl(json?.verification_uri_complete);
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || !verificationUri || !verificationUriComplete) {
    throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
  }
  const interval = json?.interval;
  const expiresIn = json?.expires_in;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SECONDS2,
    expiresInSeconds: typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEVICE_CODE_TIMEOUT_SECONDS
  };
}
function parseTokenResponse(json, operation) {
  const accessToken = json?.access_token;
  const refreshToken2 = json?.refresh_token;
  const expiresIn = json?.expires_in;
  if (typeof accessToken !== "string" || !accessToken || typeof refreshToken2 !== "string" || !refreshToken2 || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: accessToken,
    refresh: refreshToken2,
    expires: Date.now() + expiresIn * 1e3
  };
}
async function pollForToken(oauthHost, device, signal) {
  return pollOAuthDeviceCodeFlow({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const response = await fetch(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: formUrlEncode({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        signal: requestSignal(signal)
      });
      if (response.status >= 500) {
        const text = await response.text().catch(() => "");
        return {
          status: "failed",
          message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`
        };
      }
      const json = await readJson(response);
      if (response.ok && typeof json?.access_token === "string") {
        try {
          return { status: "complete", value: parseTokenResponse(json, "poll") };
        } catch (error2) {
          return { status: "failed", message: error2 instanceof Error ? error2.message : String(error2) };
        }
      }
      const error = json?.error;
      const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
      if (error === "authorization_pending") {
        return { status: "pending" };
      }
      if (error === "slow_down") {
        const interval = json?.interval;
        return {
          status: "slow_down",
          intervalSeconds: typeof interval === "number" && interval > 0 ? interval : void 0
        };
      }
      if (error === "expired_token") {
        return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
      }
      if (error === "access_denied") {
        return { status: "failed", message: "Kimi Code login was denied." };
      }
      return {
        status: "failed",
        message: `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`
      };
    }
  });
}
function isRetryableRefreshFailure(response) {
  return response.status === 429 || response.status >= 500;
}
async function refreshToken(oauthHost, refreshTokenValue, signal) {
  let lastError;
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(1e3 * 2 ** (attempt - 1), signal);
    }
    if (signal.aborted) {
      throw new Error("Kimi Code token refresh aborted");
    }
    let response;
    try {
      response = await fetch(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: formUrlEncode({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue
        }),
        signal: requestSignal(signal)
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
    const json = await readJson(response);
    if (response.ok) {
      return parseTokenResponse(json, "refresh");
    }
    if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
      const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
      throw new Error(`Kimi Code token refresh unauthorized (status ${response.status})${description}`);
    }
    if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
      continue;
    }
    const text = JSON.stringify(json);
    throw new Error(`Kimi Code token refresh failed with status ${response.status}${text ? `: ${text}` : ""}`);
  }
  throw lastError ?? new Error("Kimi Code token refresh failed");
}
async function loginKimiCoding(interaction) {
  const oauthHost = getOauthHost();
  const device = await startDeviceAuthorization(oauthHost, interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds
  });
  const token = await pollForToken(oauthHost, device, interaction.signal);
  return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
}
var kimiCodingOAuth = {
  name: "Kimi Code (subscription)",
  isSubscription: true,
  loginLabel: "Sign in with Kimi Code",
  login: loginKimiCoding,
  refresh: async (credential, signal) => {
    const token = await refreshToken(getOauthHost(), credential.refresh, signal);
    return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
  },
  async toAuth(credential) {
    return { headers: { Authorization: `Bearer ${credential.access}` } };
  }
};

// dist/auth/oauth/xai.js
var XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
var XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
var XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
var XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
var REFRESH_SKEW_MS = 5 * 60 * 1e3;
var DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
function requiredString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}
function positiveNumber(body, field) {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}
function validateVerificationUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  if (url.protocol !== "https:") {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}
async function postForm(url, fields, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(fields),
      signal
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error("Login cancelled");
    }
    throw error;
  }
  let body;
  try {
    const parsed = await response.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    if (signal.aborted) {
      throw new Error("Login cancelled");
    }
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
  }
  return {
    ok: response.ok,
    status: response.status,
    body
  };
}
function requestFailure(action, response) {
  const error = typeof response.body.error === "string" ? response.body.error : void 0;
  const description = typeof response.body.error_description === "string" ? response.body.error_description : void 0;
  const detail = [error, description].filter(Boolean).join(": ");
  return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}
function parseDeviceCode(body) {
  const interval = body.interval;
  const intervalSeconds = typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : void 0;
  const verificationUriComplete = typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0 ? validateVerificationUri(body.verification_uri_complete) : void 0;
  return {
    deviceCode: requiredString(body, "device_code"),
    userCode: requiredString(body, "user_code"),
    verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
    verificationUriComplete,
    intervalSeconds,
    expiresInSeconds: positiveNumber(body, "expires_in")
  };
}
function credentialsFromTokenResponse(body, previousRefreshToken) {
  const access = requiredString(body, "access_token");
  const refresh = body.refresh_token === void 0 && previousRefreshToken ? previousRefreshToken : requiredString(body, "refresh_token");
  const expiresInSeconds = body.expires_in === void 0 ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in");
  return {
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + expiresInSeconds * 1e3 - REFRESH_SKEW_MS
  };
}
async function requestDeviceCode(signal) {
  const response = await postForm(XAI_DEVICE_CODE_URL, {
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
    referrer: "pi"
  }, signal);
  if (!response.ok) {
    throw requestFailure("device authorization", response);
  }
  return parseDeviceCode(response.body);
}
async function pollForTokens(device, signal) {
  return pollOAuthDeviceCodeFlow({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const response = await postForm(XAI_TOKEN_URL, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_CLIENT_ID,
        device_code: device.deviceCode
      }, signal);
      if (response.ok) {
        return { status: "complete", value: credentialsFromTokenResponse(response.body) };
      }
      const error = response.body.error;
      if (error === "authorization_pending") {
        return { status: "pending" };
      }
      if (error === "slow_down") {
        const interval = response.body.interval;
        return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : void 0 };
      }
      if (error === "access_denied" || error === "authorization_denied") {
        return { status: "failed", message: "xAI device authorization was denied" };
      }
      if (error === "expired_token") {
        return { status: "failed", message: "xAI device code expired" };
      }
      return { status: "failed", message: requestFailure("device token polling", response).message };
    }
  });
}
async function loginXai(interaction) {
  const device = await requestDeviceCode(interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete ?? device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds
  });
  return pollForTokens(device, interaction.signal);
}
async function refreshXaiToken(refreshToken2, signal) {
  const response = await postForm(XAI_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: XAI_CLIENT_ID,
    refresh_token: refreshToken2
  }, signal);
  if (!response.ok) {
    throw requestFailure("token refresh", response);
  }
  return credentialsFromTokenResponse(response.body, refreshToken2);
}
var xaiOAuth = {
  name: "xAI (Grok/X subscription)",
  isSubscription: true,
  loginLabel: "Sign in with SuperGrok or X Premium",
  login: loginXai,
  refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),
  async toAuth(credential) {
    return { apiKey: credential.access };
  }
};

// dist/providers/data/github-copilot.json
var github_copilot_default = { "anthropic-messages": { "chat:claude-fable-5": { id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-fable-5.1": { id: "claude-fable-5.1", name: "Claude Fable 5.1", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-fable-5.2": { id: "claude-fable-5.2", name: "Claude Fable 5.2", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-haiku-4.5": { id: "claude-haiku-4.5", name: "Claude Haiku 4.5 (latest)", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 2e5, maxTokens: 64e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, supportsEagerToolInputStreaming: false }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-haiku-5.5": { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 1e5, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-opus-4.8": { id: "claude-opus-4.8", name: "Claude Opus 4.8", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 1e6, maxTokens: 64e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 1e6, maxTokens: 64e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-opus-5.5": { id: "claude-opus-5.5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-sonnet-4.6": { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1e6, maxTokens: 32e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true }, thinkingLevelMap: { max: "max", minimal: "low" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false }, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:claude-sonnet-5.5": { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", api: "anthropic-messages", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictTools: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" } }, "openai-completions": { "chat:gemini-3.8-flash": { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 }, contextWindow: 1e6, maxTokens: 64e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gemini-4-argon": { id: "gemini-4-argon", name: "Gemini 4 Argon", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gemini-4-carbon": { id: "gemini-4-carbon", name: "Gemini 4 Carbon", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gemini-4-hydrogen": { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gemini-4-neon": { id: "gemini-4-neon", name: "Gemini 4 Neon", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 65536, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:kimi-k3": { id: "kimi-k3", name: "Kimi K3", api: "openai-completions", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 1048576, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsStore: false, supportsReasoningEffort: true, supportsMidConvoSystemMessages: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" } }, "openai-responses": { "chat:gpt-5.3-codex": { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-5.4-nano": { id: "gpt-5.4-nano", name: "GPT-5.4 nano", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 }, contextWindow: 4e5, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-5.6-luna": { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, tiers: [{ inputTokensAbove: 2e5, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, tiers: [{ inputTokensAbove: 272e3, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-5.6-terra": { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272e3, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272e3, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }] }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6-luna": { id: "gpt-6-luna", name: "GPT-6 Luna", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272e3, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6-sol": { id: "gpt-6-sol", name: "GPT-6 Sol", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272e3, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }, contextWindow: 1e6, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272e3, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6.1-terra": { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 272e3, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6.2-astra": { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, tiers: [{ inputTokensAbove: 272e3, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:gpt-6.2-sol": { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272e3, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsOpenAIGrammarTools: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:grok-4.5": { id: "grok-4.5", name: "Grok 4.5", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 2e5, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }] }, contextWindow: 5e5, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:grok-4.6": { id: "grok-4.6", name: "Grok 4.6", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 2e5, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }] }, contextWindow: 5e5, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:grok-4.7": { id: "grok-4.7", name: "Grok 4.7", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 2e5, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 }] }, contextWindow: 5e5, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:mai-code-1.1-flash": { id: "mai-code-1.1-flash", name: "MAI-Code-1.1-Flash", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 }, contextWindow: 256e3, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:mai-code-2": { id: "mai-code-2", name: "MAI Code 2", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.5, output: 2.5, cacheRead: 0.025, cacheWrite: 0 }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" }, "chat:mai-code-2-flash": { id: "mai-code-2-flash", name: "MAI Code 2 Flash", api: "openai-responses", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text", "image"], cost: { input: 0.05, output: 0.25, cacheRead: 5e-3, cacheWrite: 0 }, contextWindow: 105e4, maxTokens: 128e3, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }, compat: { supportsStrictMode: true }, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, inputLimits: { images: { resize: { maxWidth: 2e3, maxHeight: 2e3, maxBytes: 4718592, jpegQuality: 80 } } }, type: "chat" } }, "typesafe-system-one": { "classifier:microsoft-decision-1": { type: "classifier", id: "microsoft-decision-1", name: "Microsoft-Decision-1", api: "typesafe-system-one", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com", input: ["text"], cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" } } } };

// dist/model-catalog.js
function flattenModelCatalog(groups, type) {
  return Object.fromEntries(Object.values(groups).flatMap((models) => Object.values(models)).filter((model) => model.type === type).map((model) => [model.id, model]));
}
function flattenChatModelCatalog(_provider, groups) {
  return flattenModelCatalog(groups, "chat");
}
function flattenImageModelCatalog(_provider, groups) {
  return flattenModelCatalog(groups, "image");
}
function flattenClassifierModelCatalog(_provider, groups) {
  return flattenModelCatalog(groups, "classifier");
}

// dist/providers/github-copilot.models.js
var GITHUB_COPILOT_MODELS = flattenChatModelCatalog("github-copilot", github_copilot_default);
var GITHUB_COPILOT_IMAGE_MODELS = flattenImageModelCatalog("github-copilot", github_copilot_default);
var GITHUB_COPILOT_CLASSIFIER_MODELS = flattenClassifierModelCatalog("github-copilot", github_copilot_default);

// dist/auth/oauth/github-copilot.js
var decode = (s) => atob(s);
var CLIENT_ID2 = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
var COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat"
};
var COPILOT_API_VERSION = "2026-06-01";
function normalizeDomain(input) {
  const trimmed = input.trim();
  if (!trimmed)
    return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}
function getUrls(domain) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`
  };
}
function getBaseUrlFromToken(token) {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match)
    return null;
  const proxyHost = match[1];
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}
function getGitHubCopilotBaseUrl(token, enterpriseDomain) {
  if (token) {
    const urlFromToken = getBaseUrlFromToken(token);
    if (urlFromToken)
      return urlFromToken;
  }
  if (enterpriseDomain)
    return `https://copilot-api.${enterpriseDomain}`;
  return "https://api.individual.githubcopilot.com";
}
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function parseGitHubCopilotModelCatalog(raw, allowPolicyFallback) {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Invalid Copilot models response");
  }
  const accountModels = data.flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const id = item?.id;
    if (!item || typeof id !== "string")
      return [];
    const capabilities = asRecord(item.capabilities);
    const supports = asRecord(capabilities?.supports);
    if (supports?.tool_calls === false)
      return [];
    return [
      {
        id,
        pickerEnabled: item.model_picker_enabled === true,
        policyState: asRecord(item.policy)?.state
      }
    ];
  });
  const pickerModelIds = accountModels.filter((model) => model.pickerEnabled && model.policyState !== "disabled").map((model) => model.id);
  const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
  const availableModelIds = pickerModelIds.length > 0 || !allowPolicyFallback ? pickerModelIds : accountModels.filter((model) => model.policyState === "enabled").map((model) => model.id);
  const policyModelIds = accountModels.filter((model) => model.policyState === "unconfigured" && Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) && (model.pickerEnabled || usePolicyFallback)).map((model) => model.id);
  return { availableModelIds, policyModelIds };
}
async function fetchWithRateLimitRetry(url, init, signal, retryPolicy) {
  const retryBudgetSignal = retryPolicy.maxRetries > 0 && retryPolicy.maxElapsedMs > 0 ? AbortSignal.timeout(retryPolicy.maxElapsedMs) : void 0;
  const requestSignal2 = retryBudgetSignal ? AbortSignal.any([signal, retryBudgetSignal]) : signal;
  const retryDeadline = retryBudgetSignal ? Date.now() + retryPolicy.maxElapsedMs : void 0;
  for (let retry = 0; ; retry++) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.any([requestSignal2, AbortSignal.timeout(5e3)])
    });
    if (response.status !== 429 || retry === retryPolicy.maxRetries)
      return response;
    const retryAfter = response.headers.get("retry-after");
    let delayMs = 500 * 2 ** retry;
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1e3;
      if (!Number.isFinite(delayMs))
        return response;
    }
    delayMs = Math.max(0, delayMs);
    if (retryDeadline !== void 0 && delayMs >= retryDeadline - Date.now())
      return response;
    await response.body?.cancel();
    await sleep(delayMs, requestSignal2);
  }
}
async function fetchGitHubCopilotModels(copilotToken, enterpriseDomain, signal, retryPolicy) {
  const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
  const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
  const response = await fetchWithRateLimitRetry(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${copilotToken}`,
      ...COPILOT_HEADERS,
      "X-GitHub-Api-Version": COPILOT_API_VERSION
    }
  }, signal, retryPolicy);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return parseGitHubCopilotModelCatalog(await response.json(), allowPolicyFallback);
}
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}
async function startDeviceFlow(domain, signal) {
  const urls = getUrls(domain);
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.35.0"
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID2,
      scope: "read:user"
    }),
    signal
  });
  if (!data || typeof data !== "object") {
    throw new Error("Invalid device code response");
  }
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
  const interval = data.interval;
  const expiresIn = data.expires_in;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string" || interval !== void 0 && typeof interval !== "number" || typeof expiresIn !== "number") {
    throw new Error("Invalid device code response fields");
  }
  const trustedVerificationUri = trustedHttpUrl(verificationUri);
  if (!trustedVerificationUri) {
    throw new Error("Untrusted verification_uri in device code response");
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: trustedVerificationUri,
    interval,
    expires_in: expiresIn
  };
}
async function pollForGitHubAccessToken(domain, device, signal) {
  const urls = getUrls(domain);
  return pollOAuthDeviceCodeFlow({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const raw = await fetchJson(urls.accessTokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GitHubCopilotChat/0.35.0"
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID2,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }),
        signal
      });
      if (raw && typeof raw === "object" && typeof raw.access_token === "string") {
        return { status: "complete", value: raw.access_token };
      }
      if (raw && typeof raw === "object" && typeof raw.error === "string") {
        const { error, error_description: description, interval } = raw;
        if (error === "authorization_pending") {
          return { status: "pending" };
        }
        if (error === "slow_down") {
          return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : void 0 };
        }
        const descriptionSuffix = description ? `: ${description}` : "";
        return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
      }
      return { status: "failed", message: "Invalid device token response" };
    }
  });
}
async function refreshGitHubCopilotAccessToken(refreshToken2, enterpriseDomain, signal) {
  const domain = enterpriseDomain || "github.com";
  const urls = getUrls(domain);
  const raw = await fetchJson(urls.copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken2}`,
      ...COPILOT_HEADERS
    },
    signal
  });
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }
  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response fields");
  }
  return {
    type: "oauth",
    refresh: refreshToken2,
    access: token,
    expires: expiresAt * 1e3 - 5 * 60 * 1e3,
    enterpriseUrl: enterpriseDomain
  };
}
async function refreshGitHubCopilotToken(refreshToken2, enterpriseDomain, signal) {
  const credentials = await refreshGitHubCopilotAccessToken(refreshToken2, enterpriseDomain, signal);
  const { availableModelIds } = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain, signal, {
    maxRetries: 0,
    maxElapsedMs: 0
  });
  return {
    ...credentials,
    availableModelIds
  };
}
async function enableGitHubCopilotModel(token, modelId, enterpriseDomain, signal) {
  const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
  const url = `${baseUrl}/models/${modelId}/policy`;
  let response;
  try {
    response = await fetchWithRateLimitRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
        "openai-intent": "chat-policy",
        "x-interaction-type": "chat-policy"
      },
      body: JSON.stringify({ state: "enabled" })
    }, signal, { maxRetries: 2, maxElapsedMs: 5e3 });
  } catch (error) {
    if (signal.aborted)
      throw error;
    return false;
  }
  if (response.status === 429) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.ok;
}
async function enableGitHubCopilotModels(token, modelIds, enterpriseDomain, signal) {
  const enabledModelIds = [];
  for (const modelId of modelIds) {
    try {
      if (await enableGitHubCopilotModel(token, modelId, enterpriseDomain, signal)) {
        enabledModelIds.push(modelId);
      }
    } catch (error) {
      if (signal.aborted)
        throw error;
      break;
    }
  }
  return enabledModelIds;
}
async function loginGitHubCopilot(interaction) {
  const input = await interaction.prompt({
    type: "text",
    message: "GitHub Enterprise URL/domain (blank for github.com)",
    placeholder: "company.ghe.com"
  });
  if (interaction.signal.aborted)
    throw new Error("Login cancelled");
  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain)
    throw new Error("Invalid GitHub Enterprise URL/domain");
  const domain = enterpriseDomain || "github.com";
  const device = await startDeviceFlow(domain, interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in
  });
  const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
  const credentials = await refreshGitHubCopilotAccessToken(githubAccessToken, enterpriseDomain ?? void 0, interaction.signal);
  const models = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain ?? void 0, interaction.signal, {
    maxRetries: 2,
    maxElapsedMs: 5e3
  });
  let enabledModelIds = [];
  if (models.policyModelIds.length > 0) {
    interaction.notify({ type: "progress", message: "Enabling models..." });
    enabledModelIds = await enableGitHubCopilotModels(credentials.access, models.policyModelIds, enterpriseDomain ?? void 0, interaction.signal);
  }
  return {
    ...credentials,
    availableModelIds: [.../* @__PURE__ */ new Set([...models.availableModelIds, ...enabledModelIds])]
  };
}
function copilotEnterpriseDomain(credential) {
  const enterpriseUrl = credential.enterpriseUrl;
  if (typeof enterpriseUrl !== "string" || !enterpriseUrl)
    return void 0;
  return normalizeDomain(enterpriseUrl) ?? void 0;
}
var githubCopilotOAuth = {
  name: "GitHub Copilot",
  isSubscription: true,
  login: loginGitHubCopilot,
  refresh: (credential, signal) => refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential), signal),
  /** Derive the credential-specific proxy endpoint for each request. */
  async toAuth(credential) {
    return {
      apiKey: credential.access,
      baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential))
    };
  }
};

// dist/auth/oauth/callback-server.js
import { createServer } from "node:http";

// dist/utils/oauth-page.js
var LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/></svg>`;
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function renderPage(options) {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : void 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}
function oauthSuccessHtml(message) {
  return renderPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message
  });
}
function oauthErrorHtml(message, details) {
  return renderPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details
  });
}

// dist/auth/oauth/callback-server.js
function sendPage(response, status, html) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}
async function startOAuthCallbackServer(options) {
  const { providerName, signal } = options;
  if (signal?.aborted)
    throw new Error("Login cancelled");
  let resolveWait = () => {
  };
  let rejectWait = () => {
  };
  const waitPromise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  waitPromise.catch(() => void 0);
  let claimed = false;
  let settled = false;
  let timer;
  const onAbort = () => finish({ error: new Error("Login cancelled") });
  const finish = (result) => {
    if (settled)
      return;
    settled = true;
    if (timer)
      clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if ("error" in result)
      rejectWait(result.error);
    else
      resolveWait(result.value);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== options.path) {
        sendPage(response, 404, oauthErrorHtml("Callback route not found."));
        return;
      }
      if (options.state !== void 0 && url.searchParams.get("state") !== options.state) {
        sendPage(response, 400, oauthErrorHtml("State mismatch."));
        return;
      }
      if (claimed || settled) {
        sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, description));
        finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
        return;
      }
      claimed = true;
      try {
        const value = await options.complete(code);
        sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
        finish({ value });
      } catch (error2) {
        const failure = error2 instanceof Error ? error2 : new Error(String(error2));
        sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
        finish({ error: failure });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("OAuth callback server did not bind to TCP");
  }
  server.on("error", (error) => finish({ error }));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (options.timeoutMs !== void 0) {
    timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
  }
  const redirectHost = options.redirectHost ?? options.host;
  return {
    redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
    wait: () => waitPromise,
    cancel: () => {
      if (!claimed)
        finish({ value: void 0 });
    },
    close: () => {
      finish({ error: new Error("OAuth callback server closed") });
      server.close();
    }
  };
}
async function waitForCallbackOrManualInput(interaction, callback, prompt) {
  const manualAbort = new AbortController();
  let manualError;
  const manual = interaction.prompt({ type: "manual_code", ...prompt, signal: manualAbort.signal }).then((input) => {
    callback?.cancel();
    return input;
  }).catch((error) => {
    manualError = error instanceof Error ? error : new Error(String(error));
    callback?.cancel();
    return void 0;
  });
  try {
    const value = await callback?.wait();
    if (manualError)
      throw manualError;
    if (value !== void 0)
      return { type: "callback", value };
    const input = await manual;
    if (manualError)
      throw manualError;
    return { type: "manual", input: input ?? "" };
  } finally {
    manualAbort.abort();
  }
}

// dist/auth/oauth/pkce.js
function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function generatePKCE() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

// dist/auth/oauth/openai-codex.js
var _randomBytes = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  import("node:crypto").then((m) => {
    _randomBytes = m.randomBytes;
  });
}
var CLIENT_ID3 = "app_EMoamEEZ73f0CkXaXp7hrann";
var AUTH_BASE_URL = "https://auth.openai.com";
var AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
var TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
var REDIRECT_URI = "http://localhost:1455/auth/callback";
var DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
var DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
var DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
var DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
var DEVICE_CODE_TIMEOUT_SECONDS2 = 15 * 60;
var OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";
var OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";
var SCOPE = "openid profile email offline_access";
var JWT_CLAIM_PATH = "https://api.openai.com/auth";
function getCallbackHost() {
  return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}
function createState() {
  if (!_randomBytes) {
    throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
  }
  return _randomBytes(16).toString("hex");
}
function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value)
    return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? void 0,
      state: url.searchParams.get("state") ?? void 0
    };
  } catch {
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? void 0,
      state: params.get("state") ?? void 0
    };
  }
  return { code: value };
}
function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3)
      return null;
    const payload = parts[1] ?? "";
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
async function fetchWithLoginCancellation(input, init) {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw new Error("Login cancelled");
    }
    throw error;
  }
}
async function readTokenResponse(response, operation) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
  }
  const rawJson = await response.json();
  const json = rawJson;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}
async function exchangeAuthorizationCode(code, verifier, redirectUri, signal) {
  const response = await fetchWithLoginCancellation(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID3,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    }),
    signal
  });
  return readTokenResponse(response, "exchange");
}
async function refreshAccessToken(refreshToken2, signal) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken2,
        client_id: CLIENT_ID3
      }),
      signal
    });
  } catch (error) {
    throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readTokenResponse(response, "refresh");
}
async function startOpenAICodexDeviceAuth(signal) {
  const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID3 }),
    signal
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.");
    }
    const responseBody = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`);
  }
  const rawJson = await response.json();
  const json = rawJson;
  const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
  if (!json?.device_auth_id || !json.user_code || typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds
  };
}
async function pollOpenAICodexDeviceAuth(device, signal) {
  return pollOAuthDeviceCodeFlow({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS2,
    signal,
    poll: async () => {
      const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode
        }),
        signal
      });
      if (response.ok) {
        const rawJson = await response.json();
        const json = rawJson;
        if (!json?.authorization_code || !json.code_verifier) {
          return {
            status: "failed",
            message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`
          };
        }
        return {
          status: "complete",
          value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier }
        };
      }
      if (response.status === 403 || response.status === 404) {
        return { status: "pending" };
      }
      const responseBody = await response.text().catch(() => "");
      let errorCode;
      try {
        const json = JSON.parse(responseBody);
        const error = json?.error;
        errorCode = typeof error === "object" ? error?.code : error;
      } catch {
      }
      if (errorCode === "deviceauth_authorization_pending") {
        return { status: "pending" };
      }
      if (errorCode === "slow_down") {
        return { status: "slow_down" };
      }
      return {
        status: "failed",
        message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`
      };
    }
  });
}
async function createAuthorizationFlow(originator = "pi") {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID3);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}
function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}
function credentialsFromToken(token) {
  const accountId = getAccountId(token.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId
  };
}
async function exchangeAuthorizationCodeForCredentials(code, verifier, redirectUri, signal) {
  return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}
async function loginOpenAICodexDeviceCode(interaction) {
  const device = await startOpenAICodexDeviceAuth(interaction.signal);
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS2
  });
  const code = await pollOpenAICodexDeviceAuth(device, interaction.signal);
  return exchangeAuthorizationCodeForCredentials(code.authorizationCode, code.codeVerifier, DEVICE_REDIRECT_URI, interaction.signal);
}
async function loginOpenAICodex(interaction, options) {
  const { verifier, state, url } = await createAuthorizationFlow(options?.agentName);
  const callback = await startOAuthCallbackServer({
    providerName: "OpenAI",
    host: getCallbackHost(),
    port: 1455,
    path: "/auth/callback",
    state,
    complete: async (code) => code,
    signal: interaction.signal
  }).catch(() => void 0);
  interaction.notify({
    type: "auth_url",
    url,
    instructions: "A browser window should open. Complete login to finish."
  });
  try {
    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
      placeholder: REDIRECT_URI
    });
    let code;
    if (result.type === "callback") {
      code = result.value;
    } else {
      const parsed = parseAuthorizationInput(result.input);
      if (parsed.state && parsed.state !== state)
        throw new Error("State mismatch");
      code = parsed.code;
    }
    if (!code)
      throw new Error("Missing authorization code");
    return await exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI, interaction.signal);
  } finally {
    callback?.close();
  }
}
async function refreshOpenAICodexToken(refreshToken2, signal) {
  return credentialsFromToken(await refreshAccessToken(refreshToken2, signal));
}
var openaiCodexOAuth = {
  name: "OpenAI (ChatGPT Plus/Pro)",
  isSubscription: true,
  async login(interaction, options) {
    const method = await interaction.prompt({
      type: "select",
      message: "Select OpenAI Codex login method:",
      options: [
        { id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
        { id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" }
      ]
    });
    if (method === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
      return loginOpenAICodexDeviceCode(interaction);
    }
    if (method !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
      throw new Error(`Unknown OpenAI Codex login method: ${method}`);
    }
    return loginOpenAICodex(interaction, options);
  },
  refresh: (credential, signal) => refreshOpenAICodexToken(credential.refresh, signal),
  async toAuth(credential) {
    return { apiKey: credential.access };
  }
};
export {
  githubCopilotOAuth,
  kimiCodingOAuth,
  openaiCodexOAuth,
  xaiOAuth
};
