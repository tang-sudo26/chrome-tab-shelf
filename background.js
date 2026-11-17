"use strict";

const STORAGE_KEY = "tabshelfCatalog";
const RECENT_LINK_IDS_KEY = "tabshelfRecentLinkIds";
const RECENT_LIMIT = 12;
const INBOX_ID = "inbox";
const CLOSE_TIMEOUT_MS = 3000;
const closingTabIds = new Set();

class RequestError extends Error {}

function requireInput(condition, message) {
  if (!condition) throw new RequestError(message);
}

function isRecordId(id) {
  return typeof id === "string" && id.trim().length > 0;
}

function isBrowserId(id) {
  return Number.isSafeInteger(id) && id >= 0;
}

function isWebUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isTabRef(tab) {
  return isBrowserId(tab?.id) && isWebUrl(tab.url);
}

function isRegularTab(tab) {
  return isBrowserId(tab?.id) && isBrowserId(tab.windowId) && !tab.incognito;
}

function isNormalWindow(win) {
  return win?.type === "normal" && !win.incognito;
}

function isEligibleTab(tab) {
  return isRegularTab(tab) && isWebUrl(tab.url) &&
    (tab.pendingUrl === undefined || tab.pendingUrl === tab.url);
}

async function queryNormalTabs() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  return tabs.filter(isRegularTab);
}

async function queryWebTabs() {
  return (await queryNormalTabs()).filter(isEligibleTab);
}

function titleOf(tab) {
  return tab.title || tab.url;
}

async function getCurrentWindowId(sender) {
  const senderWindowId = sender?.tab?.windowId;
  if (isBrowserId(senderWindowId)) return senderWindowId;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!win.incognito && isBrowserId(win.id)) return win.id;
  } catch {
    // The worker can have no current browser window.
  }
  return undefined;
}

async function getBatchWindowId(sender) {
  const windowId = sender?.tab?.windowId;
  if (isBrowserId(windowId)) {
    try {
      if (isNormalWindow(await chrome.windows.get(windowId))) return windowId;
    } catch {
      // The sender's window can close before the queued batch runs.
    }
  }
  return getCurrentWindowId();
}

async function readCatalog() {
  let stored;
  try {
    ({ [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY));
  } catch {
    throw new RequestError("读取收藏数据失败，请重试。");
  }

  return {
    categories: [
      { id: INBOX_ID, name: "待分类" },
      ...(stored?.categories ?? []).filter(({ id }) => id !== INBOX_ID)
    ],
    links: stored?.links ?? [],
    snapshots: stored?.snapshots ?? []
  };
}

async function writeCatalog(catalog) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: catalog });
  } catch {
    throw new RequestError("保存收藏数据失败，请重试。");
  }
}

async function readRecentLinkIds() {
  const { [RECENT_LINK_IDS_KEY]: ids } = await chrome.storage.local.get(RECENT_LINK_IDS_KEY);
  return Array.isArray(ids) ? ids : [];
}

function resolveRecentLinks(links, ids) {
  if (!ids.length) return [];
  const byId = new Map(links.map((link) => [link.id, link]));
  const seenUrls = new Set();
  const recent = [];
  for (const id of ids) {
    const link = byId.get(id);
    if (!link || seenUrls.has(link.url)) continue;
    seenUrls.add(link.url);
    recent.push(link);
    if (recent.length === RECENT_LIMIT) break;
  }
  return recent;
}

async function updateRecentLinks({ catalog, openedUrls = [] }) {
  try {
    const { links } = catalog ?? await readCatalog();
    const openedIds = [];
    if (openedUrls.length) {
      const byUrl = new Map(links.map(({ id, url }) => [url, id]));
      for (const url of openedUrls) {
        const id = byUrl.get(url);
        if (id !== undefined) openedIds.push(id);
      }
      if (!openedIds.length) return;
    }

    // Store saved link IDs so re-saving a deleted URL cannot restore its history.
    const storedIds = await readRecentLinkIds();
    const ids = resolveRecentLinks(links, [...openedIds.reverse(), ...storedIds])
      .map(({ id }) => id);
    if (ids.length !== storedIds.length || ids.some((id, index) => id !== storedIds[index])) {
      await chrome.storage.local.set({ [RECENT_LINK_IDS_KEY]: ids });
    }
  } catch {
    // Recent history is optional; the open or catalog write already succeeded.
  }
}

function requireCategory(catalog, categoryId) {
  requireInput(isRecordId(categoryId), "请选择有效的分类。");
  requireInput(catalog.categories.some(({ id }) => id === categoryId), "该分类已不存在。");
}

function addLinks(catalog, tabs, categoryId, savedAt) {
  const urls = new Set(catalog.links.map(({ url }) => url));
  let added = 0;
  for (const tab of tabs) {
    if (urls.has(tab.url)) continue;
    urls.add(tab.url);
    catalog.links.push({
      id: crypto.randomUUID(),
      url: tab.url,
      title: titleOf(tab),
      categoryId,
      savedAt
    });
    added++;
  }
  return added;
}

async function closeIfUnchanged({ id, url }) {
  if (closingTabIds.has(id)) return false;
  closingTabIds.add(id);

  const matches = (tab) => isEligibleTab(tab) && tab.pendingUrl === undefined &&
    tab.id === id && tab.url === url;
  let timedOut = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
    }, CLOSE_TIMEOUT_MS);
  });

  const attempt = (async () => {
    try {
      const before = await chrome.tabs.get(id);
      if (timedOut || !matches(before)) return false;

      const win = await chrome.windows.get(before.windowId);
      if (timedOut || !isNormalWindow(win)) return false;

      // Chrome does not offer an atomic check and close.
      const latest = await chrome.tabs.get(id);
      if (timedOut || !matches(latest) || latest.windowId !== before.windowId) return false;
      await chrome.tabs.remove(id);
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    // Chrome may never reply after Stay. Only this bounded attempt releases its
    // reservation; a late Chrome reply cannot affect a newer attempt.
    clearTimeout(timer);
    closingTabIds.delete(id);
  }
}

async function closeSavedTabs(tabs, close, keep = new Set()) {
  if (!close) return { closed: 0, closeFailed: 0 };

  const handled = new Set(keep);
  const attempts = [];
  for (const tab of tabs) {
    if (handled.has(tab.id)) continue;
    handled.add(tab.id);
    attempts.push(closeIfUnchanged(tab));
  }
  const results = await Promise.all(attempts);
  const closed = results.filter(Boolean).length;
  return { closed, closeFailed: results.length - closed };
}

function matchesOpenUrl(tab, url) {
  // A newly opened tab can have the destination only in pendingUrl.
  return isRegularTab(tab) && (tab.pendingUrl ?? tab.url) === url;
}

async function hasMatchingOpenTab(tabs, url) {
  for (const tab of tabs) {
    if (!matchesOpenUrl(tab, url)) continue;
    try {
      // Earlier opens in the batch can outlast the original tab snapshot.
      const latest = await chrome.tabs.get(tab.id);
      if (!matchesOpenUrl(latest, url)) continue;
      if (latest.windowId === tab.windowId || isNormalWindow(await chrome.windows.get(latest.windowId))) {
        return true;
      }
    } catch {
      // A matching tab or its window may have closed; try the next match.
    }
  }
  return false;
}

async function activateMatchingTab(id, url) {
  try {
    const activated = await chrome.tabs.update(id, { active: true });
    if (!matchesOpenUrl(activated, url) || activated.id !== id) return false;
    const { windowId } = activated;
    if (!isNormalWindow(await chrome.windows.get(windowId))) return false;

    const latest = await chrome.tabs.get(id);
    if (!matchesOpenUrl(latest, url) || latest.id !== id || latest.windowId !== windowId) return false;
    await chrome.windows.update(windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

const actions = {
  async getCatalog(_message, sender) {
    const [catalog, tabs, currentWindowId, recentIds] = await Promise.all([
      readCatalog(), queryWebTabs(), getCurrentWindowId(sender), readRecentLinkIds().catch(() => [])
    ]);
    return {
      ...catalog,
      recentUrls: resolveRecentLinks(catalog.links, recentIds).map(({ url }) => url),
      tabs: tabs.map(({ id, windowId, url, title, pinned }) => ({
        id, windowId, url, title: title || url, pinned: Boolean(pinned)
      })),
      ...(currentWindowId === undefined ? {} : { currentWindowId })
    };
  },

  async categoryCreate({ name }) {
    requireInput(typeof name === "string" && name.trim(), "请输入分类名称。");
    const catalog = await readCatalog();
    const id = crypto.randomUUID();
    catalog.categories.push({ id, name: name.trim() });
    await writeCatalog(catalog);
    return { id };
  },

  async linkMove({ linkId, categoryId }) {
    requireInput(isRecordId(linkId), "请选择有效的链接。");
    const catalog = await readCatalog();
    requireCategory(catalog, categoryId);
    const link = catalog.links.find(({ id }) => id === linkId);
    requireInput(link, "该链接已不存在。");
    link.categoryId = categoryId;
    await writeCatalog(catalog);
    return {};
  },

  async linksDelete({ linkIds }) {
    requireInput(Array.isArray(linkIds) && linkIds.every(isRecordId), "链接列表无效。");
    const catalog = await readCatalog();
    const ids = new Set(linkIds);
    catalog.links = catalog.links.filter(({ id }) => !ids.has(id));
    await writeCatalog(catalog);
    await updateRecentLinks({ catalog });
    return {};
  },

  async categoryDelete({ categoryId }) {
    requireInput(categoryId !== INBOX_ID, "不能删除「待分类」。");
    const catalog = await readCatalog();
    requireCategory(catalog, categoryId);
    catalog.categories = catalog.categories.filter(({ id }) => id !== categoryId);
    catalog.links = catalog.links.filter((link) => link.categoryId !== categoryId);
    await writeCatalog(catalog);
    await updateRecentLinks({ catalog });
    return {};
  },

  async shelfClear() {
    const catalog = await readCatalog();
    catalog.links = [];
    await writeCatalog(catalog);
    await updateRecentLinks({ catalog });
    return {};
  },

  async snapshotDelete({ snapshotId }) {
    requireInput(isRecordId(snapshotId), "请选择有效的快照。");
    const catalog = await readCatalog();
    catalog.snapshots = catalog.snapshots.filter(({ id }) => id !== snapshotId);
    await writeCatalog(catalog);
    return {};
  },

  async openLink({ url }, sender) {
    requireInput(isWebUrl(url), "只能打开有效的 HTTP(S) 链接。");
    const [tabs, windowId] = await Promise.all([queryNormalTabs(), getCurrentWindowId(sender)]);
    const matching = tabs.filter((tab) => matchesOpenUrl(tab, url));
    matching.sort((a, b) => Number(b.windowId === windowId) - Number(a.windowId === windowId));
    for (const { id } of matching) {
      if (await activateMatchingTab(id, url)) {
        await updateRecentLinks({ openedUrls: [url] });
        return {};
      }
    }

    try {
      await chrome.tabs.create({ url, ...(windowId === undefined ? {} : { windowId }) });
    } catch {
      throw new RequestError("打开链接失败，请重试。");
    }
    await updateRecentLinks({ openedUrls: [url] });
    return {};
  },

  async openLinks({ urls }, sender) {
    requireInput(Array.isArray(urls) && urls.length > 0, "链接列表无效或为空。");
    const uniqueUrls = [...new Set(urls)];
    requireInput(uniqueUrls.every(isWebUrl), "只能打开有效的 HTTP(S) 链接。");

    const windowId = await getBatchWindowId(sender);
    const counts = { opened: 0, reused: 0, failed: 0 };
    const openedUrls = [];
    for (const url of uniqueUrls) {
      try {
        // Tabs can open or start navigating while the previous URL is processed.
        if (await hasMatchingOpenTab(await queryNormalTabs(), url)) {
          counts.reused++;
        } else {
          await chrome.tabs.create({ url, active: false, ...(windowId === undefined ? {} : { windowId }) });
          counts.opened++;
          openedUrls.push(url);
        }
      } catch {
        counts.failed++;
      }
    }
    if (openedUrls.length) await updateRecentLinks({ openedUrls });
    return counts;
  },

  async tabSave({ tab, categoryId, close }) {
    requireInput(isTabRef(tab), "标签页信息无效，或不支持收藏该网址。");
    requireInput(typeof close === "boolean", "关闭标签页的选项无效。");
    const catalog = await readCatalog();
    requireCategory(catalog, categoryId);
    const matched = (await queryWebTabs()).find(({ id, url }) => id === tab.id && url === tab.url);
    requireInput(matched, "该标签页已关闭、网址已变化或不再支持收藏，请刷新后重试。");

    const added = addLinks(catalog, [matched], categoryId, Date.now());
    await writeCatalog(catalog);
    return { added, ...await closeSavedTabs([matched], close) };
  },

  async tabsSave({ tabs, categoryId, close }) {
    const invalidTabs = "标签页列表无效或为空，或包含不支持收藏的网址。";
    requireInput(Array.isArray(tabs) && tabs.length > 0, invalidTabs);
    requireInput(typeof close === "boolean", "关闭标签页的选项无效。");

    const requested = new Map();
    for (const tab of tabs) {
      requireInput(isTabRef(tab), invalidTabs);
      const { id, url } = tab;
      const priorUrl = requested.get(id);
      // Conflicting URLs leave the selection ambiguous, regardless of order.
      requested.set(id, priorUrl === undefined || priorUrl === url ? url : null);
    }

    const catalog = await readCatalog();
    requireCategory(catalog, categoryId);
    const shelvedUrls = new Set(catalog.links.map(({ url }) => url));
    const liveById = new Map((await queryWebTabs()).map((tab) => [tab.id, tab]));
    const matched = [];
    for (const [id, url] of requested) {
      const live = liveById.get(id);
      if (live?.url === url && !shelvedUrls.has(url)) matched.push(live);
    }

    const saved = matched.length;
    const skipped = requested.size - saved;
    if (!saved) return { saved, added: 0, skipped, closed: 0, closeFailed: 0 };

    const added = addLinks(catalog, matched, categoryId, Date.now());
    await writeCatalog(catalog);
    return { saved, added, skipped, ...await closeSavedTabs(matched, close) };
  },

  async snapshotSave({ tabs, categoryId, close, keepTabIds }) {
    requireInput(Array.isArray(tabs) && tabs.length > 0 && tabs.every(isTabRef), "快照的标签页列表无效或为空。");
    requireInput(typeof close === "boolean", "关闭标签页的选项无效。");
    requireInput(Array.isArray(keepTabIds) && keepTabIds.every(isBrowserId), "保留的标签页列表无效。");
    const catalog = await readCatalog();
    requireCategory(catalog, categoryId);
    const liveById = new Map((await queryWebTabs()).map((tab) => [tab.id, tab]));
    const matched = [];
    for (const { id, url } of tabs) {
      const live = liveById.get(id);
      if (live?.url === url) matched.push(live);
    }
    requireInput(matched.length > 0, "没有可保存的标签页，请刷新快照预览后重试。");

    const snapshotId = crypto.randomUUID();
    const createdAt = Date.now();
    const added = addLinks(catalog, matched, categoryId, createdAt);
    catalog.snapshots.push({
      id: snapshotId,
      createdAt,
      tabs: matched.map(({ url, title, windowId }) => ({ url, title: title || url, windowId }))
    });

    await writeCatalog(catalog);
    return {
      snapshotId,
      saved: matched.length,
      added,
      skipped: tabs.length - matched.length,
      ...await closeSavedTabs(matched, close, new Set(keepTabIds))
    };
  }
};

let pendingMutation = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;
  const execute = async () => {
    requireInput(typeof action === "string" && Object.hasOwn(actions, action), "不支持的操作。");
    return actions[action](message, sender);
  };

  // Reads can use the last committed catalog. Mutations wait through the
  // bounded close batch so a saved copy cannot be deleted before its close check.
  const isRead = action === "getCatalog";
  const result = isRead ? execute() : pendingMutation.then(execute);
  if (!isRead) pendingMutation = result.then(() => {}, () => {});

  result.then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof RequestError ? error.message : "处理请求失败，请重试。"
    })
  );
  return true;
});
