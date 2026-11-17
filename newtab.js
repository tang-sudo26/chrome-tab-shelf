'use strict';

const $ = (id) => document.getElementById(id);
const INBOX = 'inbox';
const ALL = Symbol('all categories');
const tabList = document.querySelector('.tabs');
const viewTabs = [...document.querySelectorAll('[role="tab"]')];
const toolbar = tabList.closest('.toolbar');
const categoryBar = $('category-bar');
const toggleCategories = $('toggle-categories');
const layoutPicker = document.querySelector('.layout-picker');
const layoutSummary = layoutPicker.querySelector('summary');
const railViewport = matchMedia('(min-width: 700px)');
const dialogs = [...document.querySelectorAll('dialog')];
const shelfPanel = $('panel-shelf');
const shelfSearchBox = $('shelf-search-box');
const search = $('shelf-search');
const rowState = new WeakMap();
const childMaps = new WeakMap();
const choices = new Map();
const selected = new Set();
const selectedUnshelved = new Map();
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

let catalog = null;
let categories = new Map();
let shelfById = new Map();
let counts = new Map();
let unshelved = [];
let activeView = 'shelf';
let activeCategory = ALL;
let categoriesOpen = false;
let visibleLinks = [];
let selecting = false;
let selectingUnshelved = false;
let busy = false;
let readInFlight = null;
let refreshTimer;
let deferredRefresh = false;
let generation = 0;
let modal = null;

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function write(element, value) {
  const next = String(value);
  if (element.textContent !== next) element.textContent = next;
}

function action(label, style, kind) {
  const button = node('button', style, label);
  button.type = 'button';
  button.dataset.action = kind;
  return button;
}

function label(element, value) {
  if (element.getAttribute('aria-label') !== value) element.setAttribute('aria-label', value);
}

function showDialog(dialog, initialFocus, data = {}, prepare) {
  setFeedback();
  dialogError(dialog);
  modal = { dialog, returnFocus: document.activeElement, ...data };
  prepare?.();
  dialog.showModal();
  dialog.scrollTop = 0;
  initialFocus.focus({ preventScroll: true });
  syncControls();
}

function closeDialog() {
  if (!modal) return;
  const { dialog, returnFocus } = modal;
  modal = null;
  dialog.close();
  if (returnFocus?.isConnected && !returnFocus.closest('[hidden], :disabled')) {
    returnFocus.focus({ preventScroll: true });
  } else {
    $(activeView + '-heading')?.focus({ preventScroll: true });
  }
}

function dialogError(dialog, message = '') {
  const region = dialog.querySelector('.dialog-error');
  region.hidden = !message;
  write(region, message);
}

function setFeedback(message = '', isError = false) {
  const tray = $('feedback');
  tray.hidden = !message;
  tray.classList.toggle('error', isError);
  write($('operation-status'), isError ? '' : message);
  write($('operation-error'), isError ? message : '');
}

async function api(actionName, params = {}) {
  const result = await globalThis.chrome?.runtime?.sendMessage({ action: actionName, ...params });
  if (!result?.ok) throw new Error(result?.error || '无法连接 TabShelf。');
  return result.data;
}

function errorMessage(error) {
  return error?.message || '遇到了未知错误。';
}

function acceptCatalog(data) {
  catalog = data;
  categories = new Map(data.categories.map((category) => [category.id, category]));
  shelfById = new Map(data.links.map((link) => [link.id, link]));
  counts = new Map();
  const urls = new Set();
  for (const link of data.links) {
    urls.add(link.url);
    counts.set(link.categoryId, (counts.get(link.categoryId) || 0) + 1);
  }
  unshelved = data.tabs.filter((tab) => !urls.has(tab.url));
  if (selectedUnshelved.size) {
    const eligible = new Map(unshelved.map(({ id, url }) => [id, url]));
    for (const [id, url] of selectedUnshelved) {
      if (eligible.get(id) !== url) selectedUnshelved.delete(id);
    }
  }
  const currentTabs = new Map(data.tabs.map((tab) => [tab.id, tab]));
  for (const [id, choice] of choices) {
    if (currentTabs.get(id)?.url !== choice.url || !categories.has(choice.categoryId)) choices.delete(id);
  }
  for (const id of selected) {
    if (!shelfById.has(id)) selected.delete(id);
  }
  if (activeCategory !== ALL && !categories.has(activeCategory)) activeCategory = ALL;
}

function refreshCatalog() {
  if (readInFlight) return readInFlight;
  const version = generation;
  $('retry-catalog').disabled = true;
  if (!catalog) $('loading').hidden = false;

  readInFlight = (async () => {
    try {
      const data = await api('getCatalog');
      if (version !== generation) return;
      acceptCatalog(data);
      $('load-error').hidden = true;
      render();
      return true;
    } catch (error) {
      if (version !== generation) return;
      $('load-error').hidden = false;
      write($('load-error-text'), '无法更新工作区：' + errorMessage(error));
    } finally {
      readInFlight = null;
      $('loading').hidden = true;
      $('retry-catalog').disabled = false;
    }
  })();
  return readInFlight;
}

function queueRefresh() {
  if (busy) {
    deferredRefresh = true;
    return;
  }
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = undefined;
    if (!busy && readInFlight) await readInFlight;
    if (busy) deferredRefresh = true;
    else await refreshCatalog();
  }, 100);
}

async function operate(actionName, params, {
  dialog = null, close = Boolean(dialog), refresh = true, success = () => '', successStatus = null,
} = {}) {
  if (busy) return;
  busy = true;
  if (refresh) generation += 1;
  if (dialog) dialogError(dialog);
  else setFeedback();
  if (successStatus) write(successStatus, '');
  syncControls();
  let message;
  let succeeded = false;
  try {
    const result = await api(actionName, params);
    message = success(result);
    succeeded = true;
  } catch (error) {
    const failure = '操作未完成：' + errorMessage(error);
    if (dialog?.open) dialogError(dialog, failure);
    else setFeedback(failure, true);
  } finally {
    if (refresh) {
      if (readInFlight) await readInFlight;
      deferredRefresh = false;
      const updated = await refreshCatalog();
      if (!updated && catalog) {
        if (activeCategory !== ALL && !categories.has(activeCategory)) activeCategory = ALL;
        render();
      }
    }
    busy = false;
    if (succeeded && close && modal?.dialog === dialog) closeDialog();
    if (message) {
      if (successStatus && dialog?.open) write(successStatus, message);
      else setFeedback(message);
    }
    syncControls();
    if (deferredRefresh || !refresh) {
      deferredRefresh = false;
      queueRefresh();
    }
  }
}

const busyActions = new Set([
  'category-new', 'category-create', 'category-delete', 'shelf-clear', 'link-delete',
  'links-delete', 'open-link', 'open-selected', 'tab-save', 'tab-save-close', 'snapshot-preview',
  'unshelved-selection-toggle', 'unshelved-save-selected', 'unshelved-save-close-selected',
  'snapshot-open-selected', 'group-open',
  'snapshot-save', 'snapshot-save-close', 'snapshot-detail', 'snapshot-delete', 'confirm-submit', 'dialog-close',
]);

function syncControls() {
  for (const button of document.querySelectorAll('button[data-action]')) {
    const disabled = (busy && busyActions.has(button.dataset.action))
      || (button.hasAttribute('data-needs-catalog') && !catalog);
    if (disabled) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }
  $('clear-shelf').disabled = !catalog?.links.length;
  $('confirm-action').disabled = modal?.dialog.id === 'confirm-dialog' && !modal.confirmation.valid;
  $('snapshot-save').disabled = !modal?.preview?.length;
  $('snapshot-save-close').disabled = !modal?.preview?.length;
  $('category-name').readOnly = busy;
  $('snapshot-category').disabled = busy;
  syncUnshelvedSelection();
  if (modal?.dialog.id === 'snapshot-dialog') {
    for (const input of $('snapshot-preview').querySelectorAll('input')) input.disabled = busy;
  }
  if (modal?.detail) {
    $('snapshot-select-all').disabled = busy || !modal.detail.tabs.length;
    for (const input of $('snapshot-detail').querySelectorAll('input')) input.disabled = busy;
  }
}

function setView(view, focus = false) {
  if (activeView === 'shelf' && view !== 'shelf') closeShelfDisclosure();
  activeView = view;
  render();
  if (focus) $('tab-' + view).focus();
}

function setCategory(id) {
  search.value = '';
  activeCategory = id;
  if (id !== ALL) categoriesOpen = true;
}

function render() {
  const shelfAvailable = !!catalog && activeView === 'shelf';
  categoryBar.hidden = toggleCategories.hidden = !shelfAvailable;
  toolbar.toggleAttribute('data-categories-open', shelfAvailable && categoriesOpen);
  toggleCategories.setAttribute('aria-expanded', String(shelfAvailable && categoriesOpen));
  for (const tab of viewTabs) {
    const view = tab.dataset.view;
    const active = view === activeView;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $('panel-' + view).hidden = !catalog || !active;
  }
  if (catalog) {
    const panel = $('panel-' + activeView);
    const focused = document.activeElement;
    const focusedInPanel = panel.contains(focused);
    const focusedInCategories = shelfAvailable && categoryBar.contains(focused);

    write($('unshelved-count'), unshelved.length);
    if (activeView === 'shelf') renderShelf();
    if (activeView === 'unshelved') renderUnshelved();
    if (activeView === 'snapshots') renderSnapshots();
    if (modal?.dialog.id === 'snapshot-dialog') {
      const picker = $('snapshot-category');
      categoryOptions(picker, picker.value || INBOX);
    }
    if (modal?.dialog.id === 'confirm-dialog') renderConfirmation();
    const focusedHidden = focused?.closest('[hidden]');
    if (focusedInPanel && !modal && (document.activeElement !== focused || focusedHidden)) {
      let replacement = focused.isConnected && !focusedHidden ? focused : null;
      const linkId = focused.closest('[data-link-id]')?.dataset.linkId;
      if (!replacement && linkId) {
        const row = panel.querySelector('[data-link-id="' + CSS.escape(linkId) + '"]');
        replacement = focused.matches('summary') ? row?.querySelector('summary')
          : [...(row?.querySelectorAll('[data-action], [data-change]') || [])]
            .find((control) => control.dataset.action === focused.dataset.action
              && control.dataset.change === focused.dataset.change);
      }
      (replacement || $(activeView + '-heading'))?.focus({ preventScroll: true });
    } else if (focusedInCategories && !modal && (document.activeElement !== focused || focusedHidden)) {
      (focused.isConnected && !focusedHidden ? focused : $('category-list').querySelector('button'))
        ?.focus({ preventScroll: true });
    }
  }
  syncControls();
}

// Reuse rows and controls so background updates leave focus, checkboxes and open pickers intact.
function keyed(parent, items, keyOf, create, update) {
  const rows = childMaps.get(parent) || new Map();
  const keys = new Set(items.map(keyOf));
  for (const [key, row] of rows) {
    if (keys.has(key)) continue;
    row.remove();
    rows.delete(key);
  }
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    let row = rows.get(key);
    if (!row) {
      row = create();
      rows.set(key, row);
    }
    update(row, item);
    if (row !== cursor) {
      if (row.isConnected && typeof parent.moveBefore === 'function') parent.moveBefore(row, cursor);
      else parent.insertBefore(row, cursor);
    }
    cursor = row.nextElementSibling;
  }
  childMaps.set(parent, rows);
}

const byId = (item) => item.id;
const optionsBySelect = new WeakMap();

function categoryOptions(select, value) {
  const current = [...categories.values()];
  const previous = optionsBySelect.get(select) || [];
  if (previous.length !== current.length || current.some((category, index) =>
    category.id !== previous[index].id || category.name !== previous[index].name
  )) {
    select.replaceChildren(...current.map(({ id, name }) => {
      const option = node('option', '', name);
      option.value = id;
      return option;
    }));
    optionsBySelect.set(select, current);
  }
  const next = categories.has(value) ? value : INBOX;
  if (select.value !== next) select.value = next;
}

function renderEmpty(container, state, icon, title, message, buttonLabel, buttonAction) {
  container.hidden = !state;
  if (!state || container.dataset.state === state) return;
  container.dataset.state = state;
  const mark = node('span', 'empty-mark', icon);
  mark.setAttribute('aria-hidden', 'true');
  container.replaceChildren(mark, node('h3', '', title), node('p', 'muted', message));
  if (buttonLabel) container.append(action(buttonLabel, 'button secondary small', buttonAction));
}

function createCategoryRow() {
  const row = node('li');
  const button = action('', 'category-button', 'category-filter');
  const name = node('span', 'category-label');
  const count = node('span', 'category-count');
  button.append(name, count);
  row.append(button);
  rowState.set(row, { button, name, count });
  return row;
}

function renderShelf() {
  const term = search.value.trim().toLowerCase();
  const currentCategory = categories.get(activeCategory);
  const groupsForNavigation = catalog.categories.filter(({ id }) =>
    id !== INBOX || counts.has(INBOX) || activeCategory === INBOX || catalog.categories.length === 1);
  const filters = [{ id: ALL, name: '全部' }, ...groupsForNavigation];

  keyed($('category-list'), filters, byId, createCategoryRow, (row, item) => {
    const { button, name, count } = rowState.get(row);
    row.dataset.categoryId = item.id === ALL ? '' : item.id;
    rowState.get(row).item = item;
    button.setAttribute('aria-pressed', String(!term && item.id === activeCategory));
    write(name, item.name);
    button.title = item.name;
    write(count, item.id === ALL ? catalog.links.length : counts.get(item.id) || 0);
  });

  visibleLinks = catalog.links.filter((link) => term
    ? link.url.toLowerCase().includes(term) || (link.title || '').toLowerCase().includes(term)
    : activeCategory === ALL || link.categoryId === activeCategory);
  write($('shelf-heading'), term ? '搜索结果' : currentCategory?.name || '全部收藏');
  write($('shelf-summary'), visibleLinks.length + ' 项');
  $('delete-category').hidden = !!term || !currentCategory || activeCategory === INBOX;
  renderSelectionBar();
  const empty = $('shelf-empty');
  if (visibleLinks.length) renderEmpty(empty, '');
  else if (term) renderEmpty(empty, 'search', '⌕', '没有找到匹配的链接',
    '试试网站域名，或搜索标题里更短的词。', '清除搜索', 'search-clear');
  else if (catalog.links.length && currentCategory) renderEmpty(empty, 'category', '▤', '这个分类还是空的',
    '可以把架子上的链接移来，或从「未上架」收进新链接。', '查看未上架', 'show-unshelved');
  else renderEmpty(empty, 'shelf', '▤', '架子还是空的',
    '去「未上架」收下想留的页，或拍张快照，一次保存这轮浏览。', '查看未上架', 'show-unshelved');

  const byCategory = groupItems(visibleLinks, (link) => link.categoryId);
  const groups = catalog.categories.filter(({ id }) => byCategory.has(id));
  const symbolByCategory = new Map(catalog.categories.filter(({ id }) => id !== INBOX)
    .map(({ id }, index) => [id, categorySymbols[index % categorySymbols.length]]));
  const list = $('shelf-list');
  list.classList.toggle('card-grid-wide', groups.length === 1);
  keyed(list, groups, byId, createShelfCard, (card, category) => {
    const links = byCategory.get(category.id);
    card.dataset.categoryId = category.id;
    updateCard(card, category.name, links.length);
    const state = rowState.get(card);
    state.item = category;
    const symbol = symbolByCategory.get(category.id) || inboxSymbol;
    if (state.symbol.getAttribute('d') !== symbol) state.symbol.setAttribute('d', symbol);
    label(state.summary, '分组操作：' + category.name);
    keyed(state.records, links, byId, createLinkRow, updateLinkRow);
  });
  renderRecentLinks(!term && activeCategory === ALL);
}

function renderRecentLinks(show) {
  const recent = [];
  if (show && Array.isArray(catalog.recentUrls) && catalog.recentUrls.length) {
    const byUrl = new Map(catalog.links.map((link) => [link.url, link]));
    for (const url of catalog.recentUrls) {
      const link = byUrl.get(url);
      if (!link) continue;
      recent.push(link);
      byUrl.delete(url);
      if (recent.length === 3) break;
    }
  }
  $('recent-links').hidden = recent.length === 0;
  keyed($('recent-list'), recent, byId, () => {
    const row = node('li');
    const button = action('', 'button secondary small recent-link', 'open-link');
    row.append(button);
    rowState.set(row, { button });
    return row;
  }, (row, item) => {
    const state = rowState.get(row);
    state.item = item;
    const title = titleOf(item);
    const shortTitle = title === item.url ? hostnameOf(item).replace(/^www\./, '') : title.split(/\s+[·|–—]\s+/, 1)[0];
    const characters = [...shortTitle];
    write(state.button, characters.length > 28 ? characters.slice(0, 27).join('') + '…' : shortTitle);
    state.button.title = title;
    label(state.button, '打开：' + title);
  });
}

function renderSelectionBar() {
  const toggle = $('toggle-selection');
  shelfPanel.toggleAttribute('data-selecting', selecting);
  toggle.setAttribute('aria-pressed', String(selecting));
  write(toggle.querySelector('span'), selecting ? '退出多选' : '多选');
  const visibleCount = visibleLinks.reduce((sum, link) => sum + Number(selected.has(link.id)), 0);
  $('shelf-selection').hidden = !selecting;
  $('selection-actions').hidden = !selected.size;
  $('select-visible').disabled = !visibleLinks.length;
  $('select-visible').checked = !!visibleLinks.length && visibleCount === visibleLinks.length;
  $('select-visible').indeterminate = visibleCount > 0 && visibleCount < visibleLinks.length;
  write($('selection-count'), selected.size
    ? '已选 ' + selected.size + ' 条' + (visibleCount < selected.size ? '（' + (selected.size - visibleCount) + ' 条不在当前列表）' : '')
    : '');
}

function renderSelection() {
  renderSelectionBar();
  for (const row of $('shelf-list').querySelectorAll('[data-link-id]')) {
    updateLinkSelection(rowState.get(row));
  }
}

function updateLinkSelection({ item, checkLabel, check, title }) {
  checkLabel.hidden = !selecting;
  check.checked = selected.has(item.id);
  label(title, (selecting ? '选择：' : '打开：') + titleOf(item));
  if (selecting) title.setAttribute('aria-pressed', String(check.checked));
  else title.removeAttribute('aria-pressed');
}

function setShelfSearch(open) {
  shelfSearchBox.hidden = !open;
  const toggle = $('toggle-shelf-search');
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    search.focus();
  } else {
    search.value = '';
    toggle.focus();
    render();
  }
}

function createRecord(kind, opener) {
  const row = node('li', 'record');
  row.dataset.kind = kind;
  const glyph = node('span', 'glyph');
  glyph.setAttribute('aria-hidden', 'true');
  const title = opener ? action('', 'record-title', opener) : node('span', 'record-title');
  const subtitle = node('span', 'record-url');
  const url = node('span');
  const text = node('div', 'record-text');
  subtitle.append(url);
  text.append(title, subtitle);
  row.append(glyph, text);
  const controls = node('div', 'record-actions');
  rowState.set(row, { glyph, title, subtitle, url, controls });
  return row;
}

function titleOf(item) {
  return item.title?.trim() || item.url;
}

function setFavicon(state, url, initial) {
  const { glyph } = state;
  const monogram = node('span', '', initial);
  glyph.classList.remove('glyph-with-favicon');
  glyph.replaceChildren(monogram);
  const source = globalThis.chrome?.runtime?.getURL?.('/_favicon/');
  if (!source) return;

  const favicon = new URL(source);
  favicon.search = new URLSearchParams({ pageUrl: url, size: '32' }).toString();
  const image = node('img');
  image.alt = '';
  image.hidden = true;
  image.addEventListener('load', () => {
    if (image.parentNode !== glyph) return;
    glyph.classList.add('glyph-with-favicon');
    monogram.hidden = true;
    image.hidden = false;
  }, { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  glyph.append(image);
  image.src = favicon.href;
}

function setWebRecord(row, item) {
  const state = rowState.get(row);
  state.item = item;
  const title = titleOf(item);
  const url = item.url;
  const isSavedLink = row.dataset.kind === 'link';
  write(state.title, title);
  state.title.title = isSavedLink && title !== url ? title + '\n' + url : title;
  state.subtitle.title = url;
  if (!isSavedLink && state.title.matches('button')) label(state.title, '打开：' + title);
  if (state.lastUrl !== url) {
    let hostname = '';
    try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* display as provided */ }
    const initial = [...(hostname || title)][0] || '·';
    if (isSavedLink) setFavicon(state, url, initial.toLocaleUpperCase());
    else write(state.glyph, initial.toLocaleUpperCase());
    state.glyph.dataset.tone = String(initial.codePointAt(0) % 3);
    state.hostname = hostname;
    state.lastUrl = url;
  }
  write(state.url, isSavedLink && pageDataset.layout === 'workbench' ? state.hostname || url : url);
  return state;
}

function createLinkRow() {
  const row = createRecord('link', 'open-link');
  const state = rowState.get(row);
  const checkLabel = node('label', 'record-check');
  const check = node('input');
  check.type = 'checkbox';
  check.dataset.change = 'link-select';
  checkLabel.append(check);
  row.prepend(checkLabel);
  const picker = node('select', 'select');
  picker.dataset.change = 'link-move';
  const moveLabel = node('label', 'record-move-label', '移动到分类');
  moveLabel.append(picker);
  const remove = action('删除', 'button subtle danger-text small', 'link-delete');
  state.controls.append(moveLabel, remove);
  const disclosure = node('details', 'record-disclosure');
  disclosure.setAttribute('name', 'shelf-disclosures');
  const summary = node('summary', 'icon-button', '…');
  disclosure.append(summary, state.controls);
  row.append(disclosure);
  Object.assign(state, { checkLabel, check, picker, remove, disclosure, summary });
  return row;
}

function updateLinkRow(row, item) {
  const state = setWebRecord(row, item);
  const { check, picker, remove, summary } = state;
  row.dataset.linkId = item.id;
  updateLinkSelection(state);
  const title = titleOf(item);
  label(check, '选择：' + title);
  label(summary, '更多操作：' + title);
  label(picker, '移动到分类：' + title);
  label(remove, '删除：' + title);
  categoryOptions(picker, item.categoryId);
}

function getOpenShelfDisclosure() {
  return categoryBar.querySelector('.category-disclosure[open]')
    || shelfPanel.querySelector(':is(.record-disclosure, .group-disclosure)[open]');
}

function closeShelfDisclosure(disclosure = getOpenShelfDisclosure(), restoreFocus = false) {
  if (!disclosure) return;
  disclosure.open = false;
  if (restoreFocus) disclosure.querySelector('summary').focus({ preventScroll: true });
}

function groupItems(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function groupTabs(tabs, currentWindowId) {
  const groups = groupItems(tabs, (tab) => tab.windowId);
  const order = [...groups.keys()];
  if (groups.has(currentWindowId)) {
    order.splice(order.indexOf(currentWindowId), 1);
    order.unshift(currentWindowId);
  }
  let number = 0;
  return order.map((id) => ({
    id, tabs: groups.get(id),
    name: id === currentWindowId ? '当前窗口'
      : currentWindowId !== undefined ? '其他窗口 ' + (++number) : '窗口 ' + (++number),
  }));
}

function createCard(tag) {
  const card = node(tag, 'card group-card');
  const header = node('div', 'card-heading');
  const heading = node('h3', 'card-title');
  const count = node('span', 'card-count');
  const records = node('ul', 'record-list');
  header.append(heading, count);
  card.append(header, records);
  rowState.set(card, { heading, count, records });
  return card;
}

const categorySymbols = [
  'M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a24 24 0 0 0 18 0m-9 1v3',
  'M12 3a9 9 0 0 0 0 18h1a1.8 1.8 0 0 0 1.4-3l-.2-.2a1.6 1.6 0 0 1 1.2-2.7H17a4 4 0 0 0 4-4c0-4.4-4-8.1-9-8.1ZM7.5 10h.1m3-3h.1m4 .5h.1m2.9 3.2h.1',
  'm8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16',
  'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
];
const inboxSymbol = 'M3 14l3-8h12l3 8v5H3Zm0 0h5l1 2h6l1-2h5';

function createShelfCard() {
  const card = createCard('li');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    class: 'category-icon', 'aria-hidden': 'true', width: 16, height: 16, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) icon.setAttribute(name, value);
  const symbol = document.createElementNS(icon.namespaceURI, 'path');
  icon.append(symbol);

  const disclosure = node('details', 'group-disclosure');
  disclosure.setAttribute('name', 'shelf-disclosures');
  const summary = node('summary', 'icon-button', '…');
  const actions = node('div', 'group-actions');
  const style = 'button subtle small';
  actions.append(action('打开本组', style, 'group-open'), action('选择本组', style, 'group-select'),
    action('查看此分类', style, 'group-filter'));
  disclosure.append(summary, actions);

  const header = card.querySelector('.card-heading');
  header.prepend(icon);
  header.append(disclosure);
  Object.assign(rowState.get(card), { symbol, summary, disclosure });
  return card;
}

function updateCard(card, name, count) {
  const state = rowState.get(card);
  write(state.heading, name);
  state.heading.title = name;
  write(state.count, count);
}

function createGroup() {
  const group = node('section', 'window-group');
  const heading = node('h3', 'window-heading');
  const records = node('ul', 'record-list');
  group.append(heading, records);
  rowState.set(group, { heading, records });
  return group;
}

function renderGroups(container, tabs, currentWindowId, createRow, updateRow) {
  keyed(container, groupTabs(tabs, currentWindowId), byId, createGroup, (group, item) => {
    const { heading, records } = rowState.get(group);
    group.dataset.windowId = item.id;
    write(heading, item.name + ' · ' + item.tabs.length + ' 页');
    keyed(records, item.tabs, byId, createRow, updateRow);
  });
}

function createTabRow() {
  const row = createRecord('tab');
  const state = rowState.get(row);
  const checkLabel = node('label', 'record-check');
  const check = node('input');
  check.type = 'checkbox';
  check.dataset.change = 'unshelved-select';
  checkLabel.hidden = true;
  checkLabel.append(check);
  row.prepend(checkLabel);
  const pin = node('span', 'pin-label', '已固定');
  const windowLabel = node('span', 'window-label');
  state.subtitle.prepend(pin, windowLabel);
  const picker = node('select', 'select');
  picker.dataset.change = 'tab-category';
  const save = action('上架', 'button secondary small', 'tab-save');
  const saveClose = action('上架并关闭', 'button subtle small', 'tab-save-close');
  state.controls.append(picker, save, saveClose);
  row.append(state.controls);
  Object.assign(state, { checkLabel, check, picker, pin, windowLabel, save, saveClose });
  return row;
}

function updateTabRow(row, item, windowName) {
  const { check, picker, pin, windowLabel, save, saveClose } = setWebRecord(row, item);
  row.dataset.tabId = item.id;
  row.dataset.windowId = item.windowId;
  pin.hidden = !item.pinned;
  windowLabel.hidden = !windowName;
  write(windowLabel, windowName || '');
  const title = titleOf(item) + (windowName ? '（' + windowName + '）' : '');
  label(check, '选择标签页：' + title);
  label(picker, '选择上架分类：' + title);
  for (const button of [save, saveClose]) {
    if (windowName) label(button, button.textContent + '：' + title);
    else button.removeAttribute('aria-label');
  }
  categoryOptions(picker, choices.get(item.id)?.categoryId || INBOX);
}

function hostnameOf({ url }) {
  try { return new URL(url).hostname || '其他网页'; } catch { return '其他网页'; }
}

function renderUnshelved() {
  const batchCategory = $('unshelved-batch-category');
  categoryOptions(batchCategory, batchCategory.value);
  const byHostname = groupItems(unshelved, hostnameOf);
  const windows = [...new Set(catalog.tabs.map((tab) => tab.windowId))]
    .filter((id) => id !== catalog.currentWindowId).sort((a, b) => a - b);
  const firstOtherWindow = catalog.currentWindowId === undefined ? 1 : 2;
  const windowNames = new Map(windows.map((id, index) => [id, '窗口 ' + (index + firstOtherWindow)]));
  if (catalog.currentWindowId !== undefined) windowNames.set(catalog.currentWindowId, '当前窗口');
  const duplicateUrls = new Set();
  const firstWindowByUrl = new Map();
  for (const { url, windowId } of unshelved) {
    if (!firstWindowByUrl.has(url)) firstWindowByUrl.set(url, windowId);
    else if (firstWindowByUrl.get(url) !== windowId) duplicateUrls.add(url);
  }
  write($('unshelved-summary'), byHostname.size + ' 个域名 · ' + unshelved.length + ' 个标签页');
  renderEmpty($('unshelved-empty'), unshelved.length ? '' : 'tabs', '✓', '没有未上架的网页',
    '打开的新网页会出现在这里。', '返回架子', 'show-shelf');
  keyed($('unshelved-groups'), [...byHostname], ([hostname]) => hostname, () => createCard('section'),
    (card, [hostname, tabs]) => {
      card.dataset.hostname = hostname;
      updateCard(card, hostname, tabs.length + ' 页');
      keyed(rowState.get(card).records, tabs, byId, createTabRow, (row, tab) => {
        updateTabRow(row, tab, duplicateUrls.has(tab.url) ? windowNames.get(tab.windowId) : '');
      });
    });
}

function syncUnshelvedSelection() {
  if (activeView !== 'unshelved' || !catalog) return;
  const toggle = $('toggle-unshelved-selection');
  const bar = $('unshelved-selection');
  const selectAll = $('unshelved-select-all');
  const count = selectedUnshelved.size;
  $('panel-unshelved').toggleAttribute('data-selecting', selectingUnshelved);
  toggle.setAttribute('aria-pressed', String(selectingUnshelved));
  write(toggle.querySelector('span'), selectingUnshelved ? '退出多选' : '多选');
  bar.hidden = !selectingUnshelved;
  const allFocused = selectAll === document.activeElement;
  selectAll.disabled = busy || !unshelved.length;
  if (allFocused && selectAll.disabled) toggle.focus({ preventScroll: true });
  selectAll.checked = count > 0 && count === unshelved.length;
  selectAll.indeterminate = count > 0 && count < unshelved.length;
  write($('unshelved-selection-count'), '已选 ' + count + ' 个标签页');
  $('unshelved-batch-category').disabled = busy;
  for (const id of ['unshelved-save-selected', 'unshelved-save-close-selected']) {
    const button = $(id);
    const focused = button === document.activeElement;
    button.disabled = !count;
    if (focused && button.disabled) toggle.focus({ preventScroll: true });
  }
  for (const row of $('unshelved-groups').querySelectorAll('[data-tab-id]')) {
    const { item, checkLabel, check, controls } = rowState.get(row);
    checkLabel.hidden = !selectingUnshelved;
    check.checked = selectedUnshelved.get(item.id) === item.url;
    check.disabled = busy;
    controls.hidden = selectingUnshelved;
  }
}

function snapshotDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormat.format(date);
}

function createSnapshotRow() {
  const row = createRecord('snapshot', 'snapshot-detail');
  row.classList.add('card');
  const state = rowState.get(row);
  write(state.glyph, '◷');
  const remove = action('删除', 'button subtle danger-text small', 'snapshot-delete');
  state.controls.append(remove);
  row.append(state.controls);
  state.remove = remove;
  return row;
}

function renderSnapshots() {
  const snapshots = [...catalog.snapshots].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  write($('snapshots-summary'), snapshots.length + ' 个快照 · 按保存时间排列');
  renderEmpty($('snapshots-empty'), snapshots.length ? '' : 'snapshots', '◷', '还没有浏览快照',
    '给打开的网页拍张快照，之后可以逐个找回。', '拍第一张快照', 'snapshot-preview');
  keyed($('snapshots-list'), snapshots, byId, createSnapshotRow, (row, item) => {
    const { title, url, remove } = rowState.get(row);
    rowState.get(row).item = item;
    row.dataset.snapshotId = item.id;
    write(title, snapshotDate(item.createdAt));
    write(url, item.tabs.length + ' 个网页 · 查看详情');
    label(title, '查看快照：' + snapshotDate(item.createdAt));
    label(remove, '删除快照：' + snapshotDate(item.createdAt));
  });
}

function createPreviewRow() {
  const row = createRecord('preview');
  const state = rowState.get(row);
  const keepLabel = node('label', 'check-label');
  const keep = node('input');
  keep.type = 'checkbox';
  keep.dataset.change = 'snapshot-keep';
  keepLabel.append(keep, document.createTextNode('留开'));
  row.append(keepLabel);
  state.keep = keep;
  return row;
}

function previewSnapshot() {
  const preview = catalog.tabs.map((tab) => ({ ...tab }));
  const keep = new Set();
  const dialog = $('snapshot-dialog');
  const picker = $('snapshot-category');
  categoryOptions(picker, INBOX);
  write($('snapshot-description'), preview.length
    ? '将预览中的 ' + preview.length + ' 个网页存入快照。勾选「留开」的页面也会保存，已有链接保留原分类。'
    : '目前没有可保存的网页。打开 HTTP 或 HTTPS 网页后，就可以拍快照。');
  picker.closest('.snapshot-settings').hidden = !preview.length;
  renderGroups($('snapshot-preview'), preview, catalog.currentWindowId, createPreviewRow, (row, tab) => {
    const state = setWebRecord(row, tab);
    row.dataset.tabId = tab.id;
    state.keep.checked = false;
    label(state.keep, '留开：' + titleOf(tab));
  });
  showDialog(dialog, preview.length ? picker : dialog.querySelector('.close-button'), { preview, keep }, renderCloseCount);
}

function renderCloseCount() {
  write($('snapshot-close-count'), '选择关闭时，预计关闭 ' + (modal.preview.length - modal.keep.size)
    + ' 页' + (modal.keep.size ? ' · 留开 ' + modal.keep.size + ' 页' : ''));
}

function showSnapshotDetail(snapshot) {
  write($('snapshot-detail-title'), snapshotDate(snapshot.createdAt));
  write($('snapshot-detail-summary'), snapshot.tabs.length + ' 个网页 · 点击标题打开');
  const container = $('snapshot-detail');
  if (snapshot.tabs.length) {
    const list = node('ul', 'record-list');
    for (const [index, tab] of snapshot.tabs.entries()) {
      const row = createRecord('snapshot-link', 'open-link');
      const state = setWebRecord(row, tab);
      state.index = index;
      const checkLabel = node('label', 'record-check');
      const check = node('input');
      check.type = 'checkbox';
      check.dataset.change = 'snapshot-link-select';
      label(check, '选择：' + titleOf(tab));
      checkLabel.append(check);
      row.prepend(checkLabel);
      list.append(row);
    }
    container.replaceChildren(list);
  } else {
    container.replaceChildren(node('p', 'muted', '这份快照中没有网页。'));
  }
  const dialog = $('snapshot-detail-dialog');
  write($('snapshot-open-status'), '');
  showDialog(dialog, dialog.querySelector('.close-button'), {
    detail: { tabs: snapshot.tabs, selected: new Set() },
  }, renderSnapshotSelection);
}

function renderSnapshotSelection() {
  const { tabs, selected } = modal.detail;
  const all = $('snapshot-select-all');
  all.checked = !!tabs.length && selected.size === tabs.length;
  all.indeterminate = selected.size > 0 && selected.size < tabs.length;
  $('snapshot-open-selected').disabled = !selected.size;
  write($('snapshot-selection-count'), '已选 ' + selected.size + ' 条');
}

function confirm(kind, subject) {
  const dialog = $('confirm-dialog');
  showDialog(dialog, $('cancel-confirm'), { confirmation: { kind, subject } }, renderConfirmation);
}

function renderConfirmation() {
  const confirmation = modal.confirmation;
  const { kind, subject } = confirmation;
  let title;
  let description;
  let confirmLabel;
  let count;
  if (kind === 'links') {
    confirmation.linkIds = subject.filter((id) => shelfById.has(id));
    count = confirmation.linkIds.length;
    title = count ? '删除 ' + count + ' 条链接？' : '链接已删除';
    description = '所选链接会从架子移除。打开的网页和快照仍会保留。';
    confirmLabel = '删除 ' + count + ' 条链接';
    confirmation.valid = count > 0;
  } else if (kind === 'category') {
    const category = categories.get(subject);
    count = counts.get(subject) || 0;
    title = category ? '删除「' + category.name + '」？' : '分类已删除';
    description = '此分类和其中的 ' + count + ' 条链接会被删除。打开的网页和快照仍会保留。';
    confirmLabel = '删除分类';
    confirmation.valid = !!category && subject !== INBOX;
  } else if (kind === 'shelf') {
    count = catalog.links.length;
    title = '清空架子上的 ' + count + ' 条链接？';
    description = '所有分类里的链接都会被移除。分类、快照和打开的网页仍会保留。';
    confirmLabel = '清空架子';
    confirmation.valid = count > 0;
  } else {
    const snapshot = catalog.snapshots.find(({ id }) => id === subject);
    count = snapshot?.tabs.length ?? 0;
    title = snapshot ? '删除这份快照？' : '快照已删除';
    description = snapshot
      ? snapshotDate(snapshot.createdAt) + ' 的快照包含 ' + count + ' 个网页。删除快照后，架子上的链接仍会保留。'
      : '此记录已不存在，架子上的链接仍会保留。';
    confirmLabel = '删除快照';
    confirmation.valid = !!snapshot;
  }
  write($('confirm-title'), title);
  write($('confirm-description'), description);
  write($('confirm-action'), confirmLabel);
  confirmation.count = count;
}

function submitConfirmation() {
  if (!modal?.confirmation?.valid) return;
  const { kind, subject, linkIds, count } = modal.confirmation;
  const options = { dialog: modal.dialog };
  if (kind === 'links') {
    void operate('linksDelete', { linkIds }, { ...options, success: () => '已删除 ' + count + ' 条链接。' });
  } else if (kind === 'category') {
    void operate('categoryDelete', { categoryId: subject }, { ...options, success: () => '已删除分类及其中的 ' + count + ' 条链接。' });
  } else if (kind === 'shelf') {
    void operate('shelfClear', {}, { ...options, success: () => '已清空架子。分类和快照仍保留。' });
  } else {
    void operate('snapshotDelete', { snapshotId: subject }, { ...options, success: () => '已删除快照。' });
  }
}

function closingResult(result) {
  return '已关闭 ' + result.closed + ' 页' + (result.closeFailed ? '，有 ' + result.closeFailed + ' 页未确认关闭' : '');
}

function saveTab(item, picker, close) {
  const { id, url } = item;
  void operate('tabSave', { tab: { id, url }, categoryId: picker.value, close }, {
    success: (result) => (result.added ? '已上架' : '这个网址已在架子上')
      + (close ? ' · ' + closingResult(result) : '') + '。',
  });
}

function saveUnshelved(close) {
  if (!selectingUnshelved || !selectedUnshelved.size) return;
  const tabs = Array.from(selectedUnshelved, ([id, url]) => ({ id, url }));
  void operate('tabsSave', { tabs, categoryId: $('unshelved-batch-category').value, close }, {
    success: (result) => {
      selectedUnshelved.clear();
      return (result.saved
        ? '已处理 ' + result.saved + ' 个标签页 · 新增 ' + result.added + ' 条链接'
        : '未上架任何标签页')
        + (result.skipped ? ' · 跳过 ' + result.skipped + ' 个已上架、关闭、变更或不再符合条件的标签页' : '')
        + (close ? ' · ' + closingResult(result) : '') + '。';
    },
  });
}

function saveSnapshot(close) {
  const { dialog, preview, keep } = modal;
  const tabs = preview.map(({ id, url }) => ({ id, url }));
  void operate('snapshotSave', {
    tabs, categoryId: $('snapshot-category').value, close, keepTabIds: [...keep],
  }, {
    dialog,
    success: (result) => '快照已保存 ' + result.saved + ' 页 · 新增 ' + result.added + ' 条链接'
      + (close ? ' · ' + closingResult(result) : '')
      + (result.skipped ? ' · 跳过 ' + result.skipped + ' 个已关闭或变更的页面' : '') + '。',
  });
}

function openSelectedLinks(urls, options) {
  if (!urls.length) return;
  void operate('openLinks', { urls }, {
    close: false,
    refresh: false,
    success: ({ opened, reused, failed }) =>
      '新打开 ' + opened + ' 个 · 原本已打开 ' + reused + ' 个 · 失败 ' + failed + ' 个。',
    ...options,
  });
}

function rowOf(target) {
  return rowState.get(target.closest('li'));
}

function closeLayoutPicker(restoreFocus = false) {
  if (!layoutPicker.open) return;
  layoutPicker.open = false;
  if (restoreFocus) layoutSummary.focus({ preventScroll: true });
}

layoutPicker.addEventListener('focusout', (event) => {
  if (event.relatedTarget && !layoutPicker.contains(event.relatedTarget)) closeLayoutPicker();
});

document.addEventListener('click', (event) => {
  if (!layoutPicker.contains(event.target)) closeLayoutPicker();
  const disclosure = getOpenShelfDisclosure();
  if (disclosure && !disclosure.contains(event.target)) closeShelfDisclosure(disclosure);
  const button = event.target.closest('button');
  if (!button) return;
  if (button.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    return;
  }
  if (button.dataset.view) {
    setView(button.dataset.view);
    return;
  }
  const { action: kind } = button.dataset;
  if (busy && busyActions.has(kind)) return;
  const row = rowOf(button);
  switch (kind) {
    case 'refresh':
      if (!busy) void refreshCatalog();
      break;
    case 'categories-toggle':
      categoriesOpen = !categoriesOpen;
      if (!categoriesOpen) activeCategory = ALL;
      render();
      break;
    case 'category-filter':
      setCategory(row.item.id);
      render();
      break;
    case 'group-open':
    case 'group-select':
    case 'group-filter': {
      const categoryId = row.item.id;
      closeShelfDisclosure(row.disclosure, kind !== 'group-filter');
      if (kind === 'group-filter') {
        setCategory(categoryId);
        render();
        $('shelf-heading').focus({ preventScroll: true });
      } else {
        const links = visibleLinks.filter((link) => link.categoryId === categoryId);
        if (kind === 'group-open') openSelectedLinks(links.map(({ url }) => url));
        else {
          selecting = true;
          for (const { id } of links) selected.add(id);
          renderSelection();
        }
      }
      break;
    }
    case 'category-new':
      closeShelfDisclosure(disclosure, true);
      $('category-form').reset();
      showDialog($('category-dialog'), $('category-name'));
      break;
    case 'category-delete':
      if (activeCategory !== ALL && activeCategory !== INBOX) {
        closeShelfDisclosure(disclosure, true);
        confirm('category', activeCategory);
      }
      break;
    case 'shelf-clear':
      if (catalog?.links.length) {
        closeShelfDisclosure(disclosure, true);
        confirm('shelf');
      }
      break;
    case 'link-delete':
      closeShelfDisclosure(disclosure, true);
      confirm('links', [row.item.id]);
      break;
    case 'links-delete':
      if (selected.size) confirm('links', [...selected]);
      break;
    case 'open-selected':
      openSelectedLinks([...selected].map((id) => shelfById.get(id)?.url).filter(Boolean));
      break;
    case 'selection-toggle':
      selecting = !selecting;
      if (!selecting) selected.clear();
      renderSelection();
      break;
    case 'selection-clear':
      selected.clear();
      renderSelection();
      (visibleLinks.length ? $('select-visible') : $('toggle-selection')).focus();
      break;
    case 'search-toggle':
      setShelfSearch(shelfSearchBox.hidden);
      break;
    case 'search-clear':
      search.value = '';
      render();
      search.focus();
      break;
    case 'show-shelf':
      setView('shelf', true);
      break;
    case 'show-unshelved':
      setView('unshelved', true);
      break;
    case 'unshelved-selection-toggle':
      selectingUnshelved = !selectingUnshelved;
      if (selectingUnshelved) categoryOptions($('unshelved-batch-category'), INBOX);
      else selectedUnshelved.clear();
      syncUnshelvedSelection();
      break;
    case 'unshelved-save-selected':
    case 'unshelved-save-close-selected':
      saveUnshelved(kind === 'unshelved-save-close-selected');
      break;
    case 'tab-save':
    case 'tab-save-close':
      if (!selectingUnshelved) saveTab(row.item, row.picker, kind === 'tab-save-close');
      break;
    case 'snapshot-preview':
      if (catalog) previewSnapshot();
      break;
    case 'snapshot-save':
    case 'snapshot-save-close':
      saveSnapshot(kind === 'snapshot-save-close');
      break;
    case 'snapshot-detail':
      showSnapshotDetail(row.item);
      break;
    case 'snapshot-open-selected': {
      if (!modal?.detail) break;
      const { dialog, detail } = modal;
      const urls = detail.tabs.filter((_, index) => detail.selected.has(index)).map(({ url }) => url);
      openSelectedLinks(urls, { dialog, successStatus: $('snapshot-open-status') });
      break;
    }
    case 'snapshot-delete':
      confirm('snapshot', row.item.id);
      break;
    case 'open-link':
      if (selecting && row.checkLabel) row.check.click();
      else void operate('openLink', { url: row.item.url }, { dialog: modal?.dialog, close: false, refresh: false });
      break;
    case 'confirm-submit':
      submitConfirmation();
      break;
    case 'dialog-close':
      closeDialog();
      break;
    case 'feedback-dismiss':
      setFeedback();
      break;
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  const row = rowOf(target);
  if (selecting && target.id === 'select-visible') {
    for (const item of visibleLinks) {
      if (target.checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    renderSelection();
  } else if (selecting && target.dataset.change === 'link-select') {
    if (target.checked) selected.add(row.item.id);
    else selected.delete(row.item.id);
    renderSelection();
  } else if (!busy && selectingUnshelved && target.id === 'unshelved-select-all') {
    selectedUnshelved.clear();
    if (target.checked) {
      for (const { id, url } of unshelved) selectedUnshelved.set(id, url);
    }
    syncUnshelvedSelection();
  } else if (!busy && selectingUnshelved && target.dataset.change === 'unshelved-select') {
    const { id, url } = row.item;
    if (target.checked) selectedUnshelved.set(id, url);
    else selectedUnshelved.delete(id);
    syncUnshelvedSelection();
  } else if (target.dataset.change === 'link-move') {
    if (busy) {
      target.value = row.item.categoryId;
      return;
    }
    if (target.value === row.item.categoryId) return;
    const categoryId = target.value;
    closeShelfDisclosure(row.disclosure, true);
    void operate('linkMove', { linkId: row.item.id, categoryId }, {
      success: () => '已移至「' + categories.get(categoryId)?.name + '」。',
    });
  } else if (target.dataset.change === 'tab-category') {
    choices.set(row.item.id, { url: row.item.url, categoryId: target.value });
  } else if (target.dataset.change === 'snapshot-keep' && modal?.preview) {
    if (target.checked) modal.keep.add(row.item.id);
    else modal.keep.delete(row.item.id);
    renderCloseCount();
    syncControls();
  } else if (!busy && modal?.detail && target.id === 'snapshot-select-all') {
    const { detail } = modal;
    detail.selected = target.checked ? new Set(detail.tabs.keys()) : new Set();
    for (const input of $('snapshot-detail').querySelectorAll('input')) input.checked = target.checked;
    renderSnapshotSelection();
  } else if (!busy && modal?.detail && target.dataset.change === 'snapshot-link-select') {
    if (target.checked) modal.detail.selected.add(row.index);
    else modal.detail.selected.delete(row.index);
    renderSnapshotSelection();
  }
});

$('category-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const input = $('category-name');
  const name = input.value.trim();
  const dialog = $('category-dialog');
  if (!name) {
    dialogError(dialog, '请输入分类名称。');
    input.focus();
    return;
  }
  void operate('categoryCreate', { name }, {
    dialog,
    success: ({ id }) => {
      setCategory(id);
      return '已创建分类「' + name + '」。';
    },
  });
});

const webSearchInput = $('web-search-input');
const webSearchSubmit = $('web-search-submit');
const webSearchError = $('web-search-error');

$('web-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (webSearchSubmit.getAttribute('aria-disabled') === 'true') return;
  webSearchError.textContent = '';
  const text = webSearchInput.value.trim();
  if (!text) return;

  webSearchSubmit.setAttribute('aria-disabled', 'true');
  try {
    await chrome.search.query({ text, disposition: 'CURRENT_TAB' });
  } catch {
    webSearchError.textContent = '暂时无法搜索网页，请重试。';
  } finally {
    webSearchSubmit.removeAttribute('aria-disabled');
  }
});

webSearchInput.addEventListener('input', () => {
  webSearchError.textContent = '';
});

search.addEventListener('input', () => {
  if (activeView === 'shelf') render();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing || modal) return;
  if (layoutPicker.open) {
    event.preventDefault();
    closeLayoutPicker(layoutPicker.contains(event.target));
    return;
  }
  if (activeView !== 'shelf') return;
  const disclosure = getOpenShelfDisclosure();
  const inSearch = shelfSearchBox.contains(event.target);
  if (disclosure) {
    event.preventDefault();
    closeShelfDisclosure(disclosure, disclosure.contains(event.target));
    if (!inSearch) return;
  }
  if (!shelfSearchBox.hidden && (inSearch || shelfPanel.contains(event.target)
    || categoryBar.contains(event.target) || event.target === document.body)) {
    event.preventDefault();
    setShelfSearch(false);
  }
});

tabList.addEventListener('keydown', (event) => {
  const index = viewTabs.indexOf(event.target);
  if (index < 0) return;
  const last = viewTabs.length - 1;
  const previous = (index + last) % viewTabs.length;
  const following = (index + 1) % viewTabs.length;
  const offsets = { ArrowLeft: previous, ArrowRight: following, Home: 0, End: last };
  if (railViewport.matches && pageDataset.layout === 'workbench') {
    offsets.ArrowUp = previous;
    offsets.ArrowDown = following;
  }
  const next = offsets[event.key];
  if (next === undefined) return;
  event.preventDefault();
  setView(viewTabs[next].dataset.view, true);
});

for (const dialog of dialogs) {
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!busy) closeDialog();
  });
}

const chromeTabs = globalThis.chrome?.tabs;
for (const name of ['onCreated', 'onRemoved', 'onUpdated', 'onAttached', 'onDetached', 'onReplaced', 'onMoved']) {
  chromeTabs?.[name]?.addListener(queueRefresh);
}
const storage = globalThis.chrome?.storage;
const preferences = new Map([
  ['tabshelfThemeMode', {
    select: $('theme-mode'), attribute: 'themeMode', modes: ['light', 'dark', 'chrome'], label: '外观',
  }],
  ['tabshelfLayoutMode', {
    select: $('layout-mode'), attribute: 'layout', modes: ['launcher', 'workbench'], label: '布局',
  }],
]);
const changedPreferences = new Set();
const pageDataset = document.documentElement.dataset;

function updateTabOrientation() {
  tabList.setAttribute('aria-orientation', railViewport.matches && pageDataset.layout === 'workbench'
    ? 'vertical' : 'horizontal');
}

railViewport.addEventListener('change', updateTabOrientation);
updateTabOrientation();

function applyPreference({ select, attribute, modes }, value) {
  const mode = modes.includes(value) ? value : modes[0];
  const layoutChanged = attribute === 'layout' && pageDataset.layout !== mode;
  pageDataset[attribute] = mode;
  select.value = mode;
  if (layoutChanged) {
    updateTabOrientation();
    if (catalog && activeView === 'shelf') render();
  }
}

storage?.onChanged?.addListener((changes, area) => {
  let needsRefresh = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    const preference = area === 'local' && preferences.get(key);
    if (preference) {
      changedPreferences.add(key);
      applyPreference(preference, newValue);
    } else {
      needsRefresh = true;
    }
  }
  if (needsRefresh) queueRefresh();
});
if (storage?.local) {
  storage.local.get([...preferences.keys()]).then((values) => {
    // Each preference may have received a newer update while the read was pending.
    for (const [key, preference] of preferences) {
      if (!changedPreferences.has(key)) applyPreference(preference, values[key]);
    }
  }).catch(() => {
    // Keep the current modes if the settings can't be read.
  }).finally(() => {
    for (const { select } of preferences.values()) select.disabled = false;
  });

  for (const [key, preference] of preferences) {
    const { select, attribute, label } = preference;
    const saveError = '暂时无法保存' + label + '设置，请重试。';
    select.addEventListener('change', async () => {
      const mode = select.value;
      try {
        await storage.local.set({ [key]: mode });
        if (attribute === 'layout') closeLayoutPicker(layoutPicker.contains(document.activeElement));
        if ($('operation-error').textContent === saveError) setFeedback();
      } catch {
        if (select.value === mode) applyPreference(preference, pageDataset[attribute]);
        setFeedback(saveError, true);
      }
    });
  }
}
window.addEventListener('focus', queueRefresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) queueRefresh();
});

render();
void refreshCatalog();
