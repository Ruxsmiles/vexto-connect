// Vexto Connect service worker
// - 右键「用 Vexto 下载」：POST /add，失败回落浏览器下载（M1）
// - 自动接管浏览器下载：downloads.onCreated + 1 秒 deadline（M2）
//
// 为什么用 onCreated 而不是 onDeterminingFilename：Edge 158 实测，MV3 worker
// 被回收后 onDeterminingFilename 不会唤醒它，下载会直接绕过接管；onCreated
// 能可靠唤醒 worker。代价是下载可能已开始写少量数据，所以这里先 pause 再交接。

// Chrome / Edge 的 service worker 需要显式导入；Firefox 事件页由清单按顺序加载。
if (typeof importScripts === "function") importScripts("common.js");

const MENU_ID = "vexto-download-link";
const MENU_TITLE = t("menuDownloadWithVexto");
const DEFAULT_ACTION_TITLE = "Vexto Connect";
const BADGE_OK = "✓";
const BADGE_ERR = "!";
const BADGE_COLOR_OK = "#45c98a";
const BADGE_COLOR_ERR = "#f0566d";
const TAKEOVER_DEADLINE_MS = 1000;
const PENDING_KEY = "pendingTakeovers";
const RECENT_KEY = "recentHandoffs";
const NOTIFY_THROTTLE_MS = 30000;
const HANDLED_TTL_MS = 10 * 60 * 1000;
const SELF_URL_TTL_MS = 15000;
const DIAG_KEY = "diagnostics";
const DIAG_LIMIT = 50;

let menuGeneration = 0;
const handledTakeovers = new Map();
const lastNotifyAt = new Map();
const selfInitiatedUrls = new Map();
let diagQueue = Promise.resolve();
let badgeGeneration = 0;

// 诊断只记录主机、结果和原因码；不记录 URL 查询串、Cookie、密钥。
function addDiagnostic(event) {
  diagQueue = diagQueue
    .then(() => appendDiagnostic(event))
    .catch((error) => console.warn("记录诊断失败：", error));
}

async function appendDiagnostic(event) {
  const stored = await ext.storage.session.get(DIAG_KEY);
  const list = Array.isArray(stored[DIAG_KEY]) ? stored[DIAG_KEY] : [];
  list.push({ at: Date.now(), ...event });
  await ext.storage.session.set({ [DIAG_KEY]: list.slice(-DIAG_LIMIT) });
}

// ── 设置缓存 ────────────────────────────────────────────────────────────
// 菜单和手动交接都从这里读，storage.onChanged 负责更新。

let settingsCache = null;
let settingsFromChange = false;
const settingsReady = ext.storage.local
  .get("settings")
  .then((stored) => {
    // 初次读取可能晚于一次 storage.onChanged，不要用旧值覆盖新值
    if (!settingsFromChange) settingsCache = normalizeSettings(stored.settings);
    return settingsCache;
  })
  .catch((error) => {
    console.warn("读取设置失败：", error);
    if (!settingsFromChange) settingsCache = normalizeSettings(null);
    return settingsCache;
  });

async function loadSettings() {
  if (settingsCache) return settingsCache;
  return settingsReady;
}

void settingsReady.then((settings) => {
  syncDownloadUi();
  refreshProtocolMode(settings);
});

let downloadUiQueue = Promise.resolve();

let downloadUiPermission = null;

async function hasDownloadUiPermission() {
  if (downloadUiPermission === null) {
    downloadUiPermission = await ext.permissions
      .contains({ permissions: ["downloads.ui"] })
      .catch(() => false);
  }
  return downloadUiPermission;
}

ext.permissions.onAdded?.addListener((added) => {
  if (added.permissions?.includes("downloads.ui")) downloadUiPermission = true;
});
ext.permissions.onRemoved?.addListener((removed) => {
  if (removed.permissions?.includes("downloads.ui")) downloadUiPermission = false;
});

function setDownloadUi(enabled) {
  downloadUiQueue = downloadUiQueue
    .then(async () => {
      if (typeof chrome.downloads?.setUiOptions !== "function") return;
      if (!(await hasDownloadUiPermission())) return;
      await chrome.downloads.setUiOptions({ enabled });
    })
    .catch((error) => console.warn("设置下载列表显示失败：", error?.message || error));
  return downloadUiQueue;
}

// 并发接管时只有最后一个结束才恢复列表
let activeTakeovers = 0;

function beginDownloadUiHide() {
  activeTakeovers += 1;
  void setDownloadUi(false);
}

function endDownloadUiHide() {
  activeTakeovers = Math.max(0, activeTakeovers - 1);
  if (activeTakeovers === 0) void setDownloadUi(true);
}

async function syncDownloadUi() {
  // 隐藏只在接管尝试期间生效；启动/设置变更时恢复浏览器下载列表
  if (activeTakeovers === 0) await setDownloadUi(true);
}

async function refreshProtocolMode(settings) {
  const cached = await readProtocolMode();
  if (cached) return;
  const v1 = await detectV1(settings);
  await writeProtocolMode(v1 ? "v1" : "compat", v1?.protocol || 3);
}

async function sendAdd(settings, payload, timeoutMs) {
  const cached = await readProtocolMode();
  if (cached && cached.mode === "v1") {
    const response = await vextoFetch(settings, "/v1/add", {
      method: "POST",
      headers: v1Headers(settings, true),
      body: JSON.stringify(payload),
      timeoutMs,
    });
    if (response.status !== 404) return { response, mode: "v1" };
    await writeProtocolMode("compat", 3);
  }
  const response = await vextoFetch(settings, "/add", {
    method: "POST",
    headers: vextoHeaders(settings, true),
    body: JSON.stringify(payload),
    timeoutMs,
  });
  return { response, mode: "compat" };
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  settingsFromChange = true;
  settingsCache = normalizeSettings(changes.settings.newValue);
  // 保存设置时重查授权，避免错过 permissions.onAdded
  downloadUiPermission = null;
  void syncDownloadUi();
  void refreshMenu();
});

// ── 右键菜单 ────────────────────────────────────────────────────────────

async function refreshMenu() {
  const generation = ++menuGeneration;
  const settings = await loadSettings();
  if (generation !== menuGeneration) return;
  await ext.contextMenus.removeAll();
  if (generation !== menuGeneration || !settings.enabled) return;
  chrome.contextMenus.create(
    { id: MENU_ID, title: MENU_TITLE, contexts: ["link"] },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("创建右键菜单失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

void refreshMenu();

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void handoffLink(info.linkUrl || "", tab?.url || "");
});

ext.notifications.onClicked.addListener(() => {
  void ext.runtime.openOptionsPage();
});

// ── 手动交接（M1）──────────────────────────────────────────────────────

function filenameFromDisposition(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ["response-content-disposition", "rscd"]) {
      const value = url.searchParams.get(key);
      if (!value) continue;
      const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(value);
      if (match) return decodeURIComponent(match[1].replace(/"/g, "").trim());
    }
  } catch {
    // 副作用只有文件名兜底失败，交给调用方继续处理。
  }
  return "";
}

function filenameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segment = url.pathname.split("/").filter(Boolean).pop() || "";
    const fromQuery = filenameFromDisposition(rawUrl);
    // GitHub 等签名链接的路径末段是资源 ID，真实文件名在
    // response-content-disposition / rscd 里。
    if (fromQuery && (!segment || /^[0-9a-f-]{16,}$/i.test(segment))) return fromQuery;
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

// GitHub Release 资源会先跳到 release-assets.githubusercontent.com 的限时签名
// 链接。Chromium 的 url 是稳定原始地址、finalUrl 是签名地址；Firefox 两者都只
// 给签名地址（见下方 webRequest 兜底）。签名地址一小时内过期，而且又长又带签
// 名，不适合交给 Vexto 排队。
const TRANSIENT_ASSET_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

function isTransientAssetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (TRANSIENT_ASSET_HOSTS.has(url.hostname.toLowerCase())) return true;
    const hasSignature =
      url.searchParams.has("jwt") ||
      url.searchParams.has("sig") ||
      url.searchParams.has("X-Amz-Signature") ||
      url.searchParams.has("X-Goog-Signature");
    const hasExpiry =
      url.searchParams.has("se") ||
      url.searchParams.has("Expires") ||
      url.searchParams.has("X-Amz-Expires");
    return hasSignature && hasExpiry;
  } catch {
    return false;
  }
}

function handoffUrl(item) {
  const original = item.url || "";
  const final = item.finalUrl || "";
  const candidate = final || original;
  if (isTransientAssetUrl(candidate)) {
    const recovered = recentGitHubReleaseUrl(item, candidate);
    if (recovered) return recovered;
  }
  if (!final) return original;
  if (
    isTransientAssetUrl(final) &&
    /^https?:\/\//i.test(original) &&
    !isTransientAssetUrl(original)
  ) {
    return original;
  }
  return final;
}

// Firefox 的 downloads.onCreated 只给跳转后的签名地址，拿不到 Chromium 那样的
// 原始 url。这里用 webRequest 在跳转前记下 GitHub Release 的稳定地址，再按文件
// 名匹配回下载项；监听范围仅限 github.com。
const GITHUB_RELEASE_PATH_RE =
  /^\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download\/(?:.+\/)?([^/]+)$/;
const GITHUB_RELEASE_URL_TTL_MS = 60 * 1000;
const recentGitHubReleaseUrls = new Map();

function rememberGitHubReleaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== "github.com") return;
    const match = GITHUB_RELEASE_PATH_RE.exec(url.pathname);
    if (!match) return;
    let filename = match[1];
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // 保留未解码的文件名，匹配不到时只是回落到签名链接。
    }
    recentGitHubReleaseUrls.set(filename, { url: rawUrl, at: Date.now() });
    if (recentGitHubReleaseUrls.size > 20) {
      const cutoff = Date.now() - GITHUB_RELEASE_URL_TTL_MS;
      for (const [key, entry] of recentGitHubReleaseUrls) {
        if (entry.at < cutoff) recentGitHubReleaseUrls.delete(key);
      }
      while (recentGitHubReleaseUrls.size > 20) {
        recentGitHubReleaseUrls.delete(recentGitHubReleaseUrls.keys().next().value);
      }
    }
  } catch {
    // 非法 URL 忽略，不影响正常下载
  }
}

function recentGitHubReleaseUrl(item, signedUrl) {
  const filename =
    filenameFromUrl(signedUrl) ||
    String(item.filename || "").split(/[\\/]/).pop() ||
    "";
  if (!filename) return "";
  const entry = recentGitHubReleaseUrls.get(filename);
  if (!entry) return "";
  if (Date.now() - entry.at > GITHUB_RELEASE_URL_TTL_MS) {
    recentGitHubReleaseUrls.delete(filename);
    return "";
  }
  return entry.url;
}

if (IS_FIREFOX && ext.webRequest?.onBeforeRequest) {
  ext.webRequest.onBeforeRequest.addListener(
    (details) => rememberGitHubReleaseUrl(details.url),
    { urls: ["*://github.com/*"] }
  );
}

async function handoffLink(linkUrl, referer) {
  await ext.action.setBadgeText({ text: "" });
  await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${t("actionBusy")}` });

  const settings = await loadSettings();

  if (!linkUrl) {
    await reportFailure(t("noLinkHeadline"), t("noLinkReason"), null);
    return;
  }
  if (!/^https?:\/\//i.test(linkUrl)) {
    await reportFailure(t("unsupportedLinkHeadline"), t("unsupportedLinkReason"), null);
    return;
  }
  if (!settings.enabled) {
    await reportFailure(t("statusDisabled"), t("extDisabledReason"), linkUrl);
    return;
  }

  const payload = { url: linkUrl, ack: "early" };
  if (settings.forwardHeaders) {
    if (referer) payload.referer = referer;
    payload.userAgent = navigator.userAgent;
  }
  const filename = filenameFromUrl(linkUrl);
  if (filename) payload.filename = filename;
  if (settings.forwardCookies) {
    const cookie = await cookieHeaderFor(linkUrl);
    if (cookie) payload.cookie = cookie;
  }

  const host = hostnameOf(linkUrl);
  let result;
  try {
    result = await sendAdd(settings, payload, ADD_TIMEOUT_MS);
  } catch (error) {
    addDiagnostic({ source: "manual", outcome: "error", host, reason: "network" });
    const reason = describeNetworkError(error, settings, ADD_TIMEOUT_MS);
    await reportFailure(t("noResponseHeadline"), reason, linkUrl);
    return;
  }
  const { response, mode } = result;

  if (response.status === 401) {
    addDiagnostic({ source: "manual", outcome: "error", host, reason: "401", protocol: mode });
    await reportFailure(t("statusSecretMismatch"), describeHttpError(401), linkUrl);
    return;
  }
  if (!response.ok) {
    addDiagnostic({
      source: "manual",
      outcome: "error",
      host,
      reason: `http-${response.status}`,
      protocol: mode,
    });
    await reportFailure(
      t("httpStatusHeadline", [String(response.status)]),
      describeHttpError(response.status),
      linkUrl
    );
    return;
  }

  const data = await readJson(response);
  if (data && data.action === "accepted") {
    addDiagnostic({ source: "manual", outcome: "accepted", host, protocol: mode });
    await reportSuccess();
    return;
  }

  addDiagnostic({
    source: "manual",
    outcome: "fallback",
    host,
    protocol: mode,
    reason: data?.reason || "unknown",
  });
  const reason =
    data && data.reason === "rejected"
      ? t("rejectedReasonLong")
      : t("notTakenReason", [data ? JSON.stringify(data) : t("unparseable")]);
  await reportFailure(t("fellBackHeadline"), reason, linkUrl);
}

async function reportSuccess() {
  await ext.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
  await ext.action.setBadgeText({ text: BADGE_OK });
  await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${t("actionHandedOff")}` });
  clearBadgeSoon();
}

async function reportFailure(headline, reason, fallbackUrl) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await ext.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await ext.action.setBadgeText({ text: BADGE_ERR });
    await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });

    const fallbackNote = fallbackUrl ? t("usedBrowserDownload") : "";
    notify(`${DEFAULT_ACTION_TITLE} · ${headline}`, joinSentences(reason, fallbackNote));
  } catch (error) {
    // 状态展示失败也不能影响回落下载
    console.warn("显示失败状态时出错：", error);
  } finally {
    if (fallbackUrl) startBrowserDownload(fallbackUrl);
    clearBadgeSoon();
  }
}

function startBrowserDownload(url) {
  // 标记为自己的下载，避免开启自动接管后被再次拦截
  rememberSelfDownload(url);
  if (activeTakeovers === 0) void setDownloadUi(true);
  chrome.downloads.download({ url, saveAs: false }, () => {
    if (chrome.runtime.lastError) {
      notify(
        `${DEFAULT_ACTION_TITLE} · ${t("browserDownloadNotStarted")}`,
        t("browserDownloadFailed", [chrome.runtime.lastError.message])
      );
    }
  });
}

function rememberSelfDownload(url) {
  selfInitiatedUrls.set(url, Date.now());
  if (selfInitiatedUrls.size > 100) {
    const cutoff = Date.now() - SELF_URL_TTL_MS;
    for (const [key, at] of selfInitiatedUrls) {
      if (at < cutoff) selfInitiatedUrls.delete(key);
    }
  }
}

function isSelfDownload(url) {
  const at = selfInitiatedUrls.get(url);
  if (!at) return false;
  if (Date.now() - at > SELF_URL_TTL_MS) {
    selfInitiatedUrls.delete(url);
    return false;
  }
  return true;
}

// ── 自动接管（M2）──────────────────────────────────────────────────────

ext.downloads.onCreated.addListener((item) => {
  void maybeTakeOver(item);
});

function autoTakeOverDecision(item, settings) {
  const url = handoffUrl(item);
  if (!settings.enabled || !settings.autoTakeover) return "disabled";
  if (!/^https?:\/\//i.test(url)) return "non-http";
  // 扩展自己发起的下载（例如右键失败后的回落）不再接管，避免循环
  if (item.byExtensionId || isSelfDownload(url)) return "self";
  if (item.state !== "in_progress" && item.state !== "complete") return "state";

  const hostname = hostnameOf(url);
  if (!hostname) return "invalid-url";
  if (settings.siteRules.block.some((rule) => matchesSiteRule(hostname, rule))) return "site-block";
  if (
    settings.siteRules.allow.length &&
    !settings.siteRules.allow.some((rule) => matchesSiteRule(hostname, rule))
  ) {
    return "site-allow";
  }

  if (settings.minimumSizeMb > 0) {
    const minBytes = settings.minimumSizeMb * 1024 * 1024;
    if (item.fileSize > 0) {
      if (item.fileSize < minBytes) return "size";
    } else if (!settings.unknownSizeTakeover) {
      return "size-unknown";
    }
  }
  return null;
}

const DIAG_SKIP_REASONS = new Set(["site-block", "site-allow", "size", "size-unknown"]);

function shouldAutoTakeOver(item, settings) {
  return autoTakeOverDecision(item, settings) === null;
}

async function maybeTakeOver(item) {
  if (wasHandled(item.id)) return;
  const settings = await loadSettings();

  const decision = autoTakeOverDecision(item, settings);
  if (decision) {
    if (DIAG_SKIP_REASONS.has(decision)) {
      addDiagnostic({
        source: "auto",
        outcome: "skipped",
        host: hostnameOf(handoffUrl(item)),
        reason: decision,
      });
    }
    return;
  }

  // 尽早隐藏下载列表：浏览器通常在下载创建后几十毫秒内就画出下载栏，
  // 若等到 50ms 复查之后才隐藏，下载栏往往已经出现。
  const hideUi = Boolean(settings.hideDownloadUi);
  if (hideUi) beginDownloadUiHide();

  try {
    // 先暂停，尽量在写入数据前停住；50ms 后再复查 byExtensionId。
    // Firefox 的 pause 会取消下载，改为直接交接。
    if (!IS_FIREFOX) {
      chrome.downloads.pause(item.id, () => {
        void chrome.runtime.lastError;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    let fresh = item;
    try {
      [fresh] = await ext.downloads.search({ id: item.id });
    } catch {
      fresh = null;
    }
    if (!fresh) return;

    const freshDecision = autoTakeOverDecision(fresh, settings);
    if (freshDecision) {
      resumeDownload(item.id);
      if (DIAG_SKIP_REASONS.has(freshDecision)) {
        addDiagnostic({
          source: "auto",
          outcome: "skipped",
          host: hostnameOf(handoffUrl(fresh)),
          reason: freshDecision,
        });
      }
      return;
    }

    if (await isDuplicateHandoff(fresh, settings)) {
      resumeDownload(item.id);
      addDiagnostic({
        source: "auto",
        outcome: "skipped",
        host: hostnameOf(handoffUrl(fresh)),
        reason: "duplicate",
      });
      console.info("Vexto Connect：重复下载，跳过接管");
      return;
    }
    await rememberHandoff(fresh, settings);
    await beginTakeover(fresh, settings);
  } finally {
    if (hideUi) endDownloadUiHide();
  }
}

function wasHandled(id) {
  const at = handledTakeovers.get(id);
  if (!at) return false;
  if (Date.now() - at > HANDLED_TTL_MS) {
    handledTakeovers.delete(id);
    return false;
  }
  return true;
}

function markHandled(id) {
  handledTakeovers.set(id, Date.now());
  if (handledTakeovers.size > 500) {
    const cutoff = Date.now() - HANDLED_TTL_MS;
    for (const [key, at] of handledTakeovers) {
      if (at < cutoff) handledTakeovers.delete(key);
    }
  }
}

async function takeoverPayload(item, settings) {
  const url = handoffUrl(item);
  const payload = { url, ack: "early" };
  if (settings.forwardHeaders) {
    if (item.referrer) payload.referer = item.referrer;
    payload.userAgent = navigator.userAgent;
  }
  // onCreated 阶段浏览器可能还没确定文件名，用 URL 最后一段兜底
  const filename = item.filename || filenameFromUrl(url);
  if (filename) payload.filename = filename;
  if (Number.isFinite(item.fileSize) && item.fileSize > 0) payload.size = item.fileSize;
  if (settings.forwardCookies) {
    const cookie = await cookieHeaderFor(url);
    if (cookie) payload.cookie = cookie;
  }
  return payload;
}

async function handoffKey(item) {
  const url = handoffUrl(item);
  const filename = item.filename || filenameFromUrl(url);
  return `${url}|${filename}`;
}

async function isDuplicateHandoff(item, settings) {
  if (!(settings.duplicateWindowSeconds > 0)) return false;
  try {
    const key = await handoffKey(item);
    const stored = await ext.storage.session.get(RECENT_KEY);
    const map = stored[RECENT_KEY] || {};
    const at = map[key];
    return Boolean(at) && Date.now() - at < settings.duplicateWindowSeconds * 1000;
  } catch (error) {
    console.warn("检查重复下载失败：", error);
    return false;
  }
}

async function rememberHandoff(item, settings) {
  if (!(settings.duplicateWindowSeconds > 0)) return;
  try {
    const key = await handoffKey(item);
    const stored = await ext.storage.session.get(RECENT_KEY);
    const map = stored[RECENT_KEY] || {};
    const cutoff = Date.now() - settings.duplicateWindowSeconds * 1000;
    for (const [k, at] of Object.entries(map)) {
      if (at < cutoff) delete map[k];
    }
    map[key] = Date.now();
    await ext.storage.session.set({ [RECENT_KEY]: map });
  } catch (error) {
    console.warn("记录重复下载失败：", error);
  }
}

async function cookieHeaderFor(url) {
  try {
    const cookies = await ext.cookies.getAll({ url });
    cookies.sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0));
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch (error) {
    addDiagnostic({ outcome: "cookie-error", reason: "read-failed" });
    console.warn("读取 Cookie 失败：", error?.message || error);
    return "";
  }
}

async function beginTakeover(item, settings) {
  markHandled(item.id);
  const url = handoffUrl(item);
  const host = hostnameOf(url);

  let settled = false;
  // 安全网：Chrome / Edge 暂停后卡住时必须恢复浏览器下载；Firefox 没有暂停。
  const guard = IS_FIREFOX
    ? null
    : setTimeout(() => {
        if (!settled) resumeDownload(item.id);
      }, TAKEOVER_DEADLINE_MS + 500);

  try {
    await setPending(item.id, {
      url,
      startedAt: Date.now(),
      stage: IS_FIREFOX ? "handoff" : "paused",
    });
    if (!IS_FIREFOX) {
      chrome.downloads.pause(item.id, () => {
        void chrome.runtime.lastError;
      });
    }

    let result;
    try {
      const payload = await takeoverPayload(item, settings);
      result = await sendAdd(settings, payload, TAKEOVER_DEADLINE_MS);
    } catch (error) {
      addDiagnostic({ source: "auto", outcome: "error", host, reason: "network" });
      const reason = describeNetworkError(error, settings, TAKEOVER_DEADLINE_MS);
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure(t("noResponseRestored"), reason);
      return;
    }
    const { response, mode } = result;

    if (response.status === 401) {
      addDiagnostic({ source: "auto", outcome: "error", host, reason: "401", protocol: mode });
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure(t("secretMismatchRestored"), describeHttpError(401));
      return;
    }
    if (!response.ok) {
      addDiagnostic({
        source: "auto",
        outcome: "error",
        host,
        reason: `http-${response.status}`,
        protocol: mode,
      });
      await clearPending(item.id);
      settled = true;
      resumeDownload(item.id);
      await reportTakeoverFailure(
        t("httpStatusRestored", [String(response.status)]),
        describeHttpError(response.status)
      );
      return;
    }

    const data = await readJson(response);
    if (data && data.action === "accepted") {
      await clearPending(item.id);
      settled = true;
      const removal = await removeBrowserDownload(item.id);
      addDiagnostic({
        source: "auto",
        outcome: "accepted",
        host,
        protocol: mode,
        browser: removal.action,
      });
      if (removal.ok) {
        await reportTakeoverSuccess();
      } else {
        await reportTakeoverPartial(
          t("handedOffNotCanceled"),
          removal.error || removal.action,
          removal.filename
        );
      }
      return;
    }

    addDiagnostic({
      source: "auto",
      outcome: "fallback",
      host,
      protocol: mode,
      reason: data?.reason || "unknown",
    });
    const reason =
      data && data.reason === "rejected"
        ? t("rejectedReasonShort")
        : t("notTakenReason", [data ? JSON.stringify(data) : t("unparseable")]);
    await clearPending(item.id);
    settled = true;
    resumeDownload(item.id);
    await reportTakeoverFailure(t("restoredBrowserDownload"), reason);
  } catch (error) {
    addDiagnostic({ source: "auto", outcome: "error", host, reason: "exception" });
    console.warn("自动接管出错，恢复浏览器下载：", error);
    await clearPending(item.id).catch(() => {});
    settled = true;
    resumeDownload(item.id);
    await reportTakeoverFailure(t("autoTakeoverError"), String(error?.message || error));
  } finally {
    clearTimeout(guard);
  }
}

function resumeDownload(id) {
  // Firefox 从未暂停下载，恢复会报错并可能影响下载
  if (IS_FIREFOX) return;
  chrome.downloads.resume(id, () => {
    void chrome.runtime.lastError;
  });
}

async function removeBrowserDownload(id) {
  let item = null;
  try {
    [item] = await ext.downloads.search({ id });
  } catch (error) {
    return { ok: false, action: "search-failed", error: error?.message || String(error) };
  }
  if (!item) return { ok: true, action: "already-gone" };

  const wasComplete = item.state === "complete";
  try {
    if (wasComplete) {
      await ext.downloads.removeFile(id);
    } else {
      await ext.downloads.cancel(id);
    }
  } catch (error) {
    return {
      ok: false,
      action: wasComplete ? "remove-failed" : "cancel-failed",
      error: error?.message || String(error),
      filename: item.filename,
    };
  }

  try {
    await ext.downloads.erase({ id });
  } catch (error) {
    console.warn("清除下载记录失败：", error?.message || error);
  }
  return { ok: true, action: wasComplete ? "removed" : "canceled", filename: item.filename };
}

async function reportTakeoverSuccess() {
  try {
    await ext.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
    await ext.action.setBadgeText({ text: BADGE_OK });
    await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${t("actionTakenOver")}` });
  } catch (error) {
    console.warn("显示接管成功状态失败：", error);
  }
  clearBadgeSoon();
}

async function reportTakeoverPartial(headline, reason, filename) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await ext.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await ext.action.setBadgeText({ text: BADGE_ERR });
    await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });
  } catch (error) {
    console.warn("显示接管失败状态失败：", error);
  }
  const fileNote = filename ? t("fileLabel", [filename]) : "";
  notify(`${DEFAULT_ACTION_TITLE} · ${headline}`, joinSentences(reason, fileNote));
  clearBadgeSoon();
}

async function reportTakeoverFailure(headline, reason) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await ext.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await ext.action.setBadgeText({ text: BADGE_ERR });
    await ext.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });
  } catch (error) {
    console.warn("显示接管失败状态失败：", error);
  }
  notifyThrottled(headline, `${DEFAULT_ACTION_TITLE} · ${headline}`, reason);
  clearBadgeSoon();
}

function notifyThrottled(key, title, message) {
  const now = Date.now();
  if (now - (lastNotifyAt.get(key) || 0) < NOTIFY_THROTTLE_MS) return;
  lastNotifyAt.set(key, now);
  notify(title, message);
}

// ── 进行中的交接（storage.session）──────────────────────────────────────

async function setPending(id, entry) {
  const stored = await ext.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] || {};
  pending[id] = entry;
  await ext.storage.session.set({ [PENDING_KEY]: pending });
}

async function clearPending(id) {
  const stored = await ext.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] || {};
  if (!(id in pending)) return;
  delete pending[id];
  if (Object.keys(pending).length) {
    await ext.storage.session.set({ [PENDING_KEY]: pending });
  } else {
    await ext.storage.session.remove(PENDING_KEY);
  }
}

// worker 重启后，把上次被暂停、还没恢复的下载放行
async function recoverPendingTakeovers() {
  let pending = {};
  try {
    pending = (await ext.storage.session.get(PENDING_KEY))[PENDING_KEY] || {};
  } catch (error) {
    console.warn("读取未完成交接失败：", error);
    return;
  }
  const ids = Object.keys(pending);
  if (!ids.length) return;
  for (const key of ids) {
    const id = Number(key);
    try {
      const [item] = await ext.downloads.search({ id });
      if (item && item.state === "in_progress" && item.paused) {
        resumeDownload(id);
      }
    } catch (error) {
      console.warn(`恢复下载 ${id} 失败：`, error);
    }
  }
  await ext.storage.session.remove(PENDING_KEY);
  addDiagnostic({ source: "auto", outcome: "recovered", count: ids.length });
  console.warn(`Vexto Connect：恢复了 ${ids.length} 条未完成的交接记录`);
}

void recoverPendingTakeovers();

// ── 通用 ────────────────────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("通知失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

function clearBadgeSoon() {
  const generation = ++badgeGeneration;
  setTimeout(() => {
    // 只清除本次设置的状态，避免旧定时器抹掉新交接的 badge
    if (generation === badgeGeneration) {
      void ext.action.setBadgeText({ text: "" });
    }
  }, 3000);
}
