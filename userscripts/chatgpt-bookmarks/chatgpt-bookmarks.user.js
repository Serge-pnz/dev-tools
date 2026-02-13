// ==UserScript==
// @name         ChatGPT Message Bookmarks
// @namespace    Solaris_namespace_bookmarks
// @version      0.4.1
// @description  Bookmarks for messages in the current chat: ☆/★ on messages + top-right panel + bookmark title editing
// @author       Serge_pnz & ChatGPT
// @homepage     https://solaris.marketing/
// @downloadURL  https://github.com/Serge-pnz/dev-tools/raw/refs/heads/main/userscripts/chatgpt-bookmarks/chatgpt-bookmarks.user.js
// @updateURL    https://github.com/Serge-pnz/dev-tools/raw/refs/heads/main/userscripts/chatgpt-bookmarks/chatgpt-bookmarks.user.js
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    panelTopPx: 50,
    panelRightPx: 12,
    panelWidthPx: 320,
    panelMaxVh: 60, // 3/5 высоты экрана
    excerptLen: 90,
    seekMaxSteps: 18,
    seekStepViewportK: 0.85,
    highlightMs: 1200,
    urlPollMs: 800,
  };

  const LS_PREFIX = 'cgBookmarks:v1:';
  const ATTR_KEY = 'data-sam-bm-key';
  const ATTR_DONE = 'data-sam-bm-done';

  const log = (...a) => console.log('[cg-bm]', ...a);

  // ---------- helpers ----------
  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function djb2Hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  function cssEscape(s) {
    return (s || '').replace(/["\\]/g, '\\$&');
  }

  function getConvId() {
    const p = location.pathname || '';
    const m = p.match(/\/c\/([a-zA-Z0-9-]+)/);
    if (m) return 'c:' + m[1];
    return 'p:' + p.replace(/[^\w-/:.]/g, '_');
  }

  function storageKey() {
    return LS_PREFIX + getConvId();
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(storageKey());
      const arr = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(arr) ? arr : [];
      // миграция: если нет title — поставить excerpt
      for (const b of list) {
        if (!b.title) b.title = b.excerpt || '(без текста)';
      }
      return list;
    } catch (e) {
      return [];
    }
  }

  function saveBookmarks(list) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(list || []));
    } catch (e) {}
  }

  function pickScroller() {
    const candidates = [
      document.querySelector('main'),
      document.querySelector('div[role="main"]'),
      document.querySelector('#__next main'),
      document.querySelector('body'),
    ].filter(Boolean);

    for (const el of candidates) {
      const st = getComputedStyle(el);
      const oy = (st.overflowY || '').toLowerCase();
      const canScroll = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20;
      if (canScroll) {
        return {
          isWindow: false,
          el,
          getTop: () => el.scrollTop,
          setTop: (v, smooth) => el.scrollTo({ top: v, behavior: smooth ? 'smooth' : 'auto' }),
          scrollBy: (dy, smooth) => el.scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' }),
          getHeight: () => el.clientHeight || window.innerHeight,
        };
      }
    }

    return {
      isWindow: true,
      el: window,
      getTop: () => window.scrollY || document.documentElement.scrollTop || 0,
      setTop: (v, smooth) => window.scrollTo({ top: v, behavior: smooth ? 'smooth' : 'auto' }),
      scrollBy: (dy, smooth) => window.scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' }),
      getHeight: () => window.innerHeight || 800,
    };
  }

  // ---------- UI ----------
  let panel, listBox, counterBox, hintBox;
  let bookmarks = loadBookmarks();

  function injectCss() {
    if (document.getElementById('sam-bm-style')) return;

    const st = document.createElement('style');
    st.id = 'sam-bm-style';
    st.textContent = `
#sam-bm-panel{
  position:fixed;
  top:${CFG.panelTopPx}px;
  right:${CFG.panelRightPx}px;
  width:${CFG.panelWidthPx}px;

  /* ограничение высоты: 3/5 экрана, но не ниже низа окна с учетом top */
  max-height: min(${CFG.panelMaxVh}vh, calc(100vh - ${CFG.panelTopPx + 12}px));

  z-index: 39;
  border-radius: 12px;
  border: 1px solid rgba(0,0,0,.12);
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  backdrop-filter: blur(6px);
  overflow: hidden;
  font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;

  display:flex;
  flex-direction:column;
}

#sam-bm-panel .sam-bm-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap: 8px;
  padding: 10px 10px 8px 10px;
  border-bottom: 1px solid rgba(0,0,0,.10);
  flex: 0 0 auto;
}

#sam-bm-panel .sam-bm-title{
  font-weight: 700;
  letter-spacing: .2px;
  user-select: none;
}

#sam-bm-panel .sam-bm-count{
  opacity:.7;
  user-select:none;
}

#sam-bm-panel .sam-bm-list{
  padding: 6px 6px 8px 6px;
  overflow:auto;

  flex: 1 1 auto;
  min-height: 0; /* важно для корректного overflow в flex-контейнере */
}

#sam-bm-panel .sam-bm-item{
  display:flex;
  align-items:flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 10px;
  cursor:pointer;
  user-select:none;
}

#sam-bm-panel .sam-bm-item:hover{
  background: rgba(0,0,0,.06);
}

#sam-bm-panel .sam-bm-role{
  width: 18px;
  flex: 0 0 18px;
  opacity:.8;
  text-align:center;
  margin-top: 1px;
}

#sam-bm-panel .sam-bm-text{
  flex: 1 1 auto;
  opacity:.92;
  word-break: break-word;
}

#sam-bm-panel .sam-bm-actions{
  flex: 0 0 auto;
  display:flex;
  gap: 6px;
  align-items:flex-start;
}

#sam-bm-panel .sam-bm-del,
#sam-bm-panel .sam-bm-edit{
  opacity:.65;
  border: none;
  background: transparent;
  cursor:pointer;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
}

#sam-bm-panel .sam-bm-del:hover,
#sam-bm-panel .sam-bm-edit:hover{ opacity: 1; }

#sam-bm-panel .sam-bm-hint{
  padding: 6px 10px 10px 10px;
  font-size: 11px;
  opacity: .65;
  flex: 0 0 auto;
}

#sam-bm-panel .sam-bm-input{
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(0,0,0,.2);
  padding: 6px 8px;
  font: inherit;
  outline: none;
}

.sam-bm-btn{
  position:absolute;
  top: 8px;
  right: -25px;
  z-index: 5;
  border: none;
  background: transparent;
  cursor:pointer;
  font-size: 16px;
  line-height: 1;
  opacity: .55;
  padding: 2px 4px;
}
.sam-bm-btn:hover{ opacity: .95; }
.sam-bm-msgwrap{ position: relative !important; }

.sam-bm-highlight{
  outline: 3px solid rgba(255,200,0,.65);
  outline-offset: 3px;
  border-radius: 10px;
  transition: outline .2s ease;
}

/* ===== Dark mode: white text + yellow stars/hint/outline ===== */
@media (prefers-color-scheme: dark){
  #sam-bm-panel{
    background: rgba(10,10,10,.92);
    color: #fff;
    border-color: rgba(255,255,255,.14);
    box-shadow: 0 10px 35px rgba(0,0,0,.55);
  }
  #sam-bm-panel .sam-bm-head{ border-bottom-color: rgba(255,255,255,.10); }
  #sam-bm-panel .sam-bm-item:hover{ background: rgba(255,255,255,.06); }
  #sam-bm-panel .sam-bm-count{ opacity: .7; }

  #sam-bm-panel .sam-bm-hint{ color: #ffd24a; opacity: .9; }

  #sam-bm-panel .sam-bm-del,
  #sam-bm-panel .sam-bm-edit{ color: rgba(255,255,255,.75); }

  #sam-bm-panel .sam-bm-input{
    background: rgba(0,0,0,.35);
    color: #fff;
    border-color: rgba(255,255,255,.18);
  }

  .sam-bm-btn{ color: #ffd24a; }
}
`;
    document.head.appendChild(st);
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;

    injectCss();

    panel = document.createElement('div');
    panel.id = 'sam-bm-panel';

    const head = document.createElement('div');
    head.className = 'sam-bm-head';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'baseline';
    left.style.gap = '8px';

    const title = document.createElement('div');
    title.className = 'sam-bm-title';
    title.textContent = 'Закладки';

    counterBox = document.createElement('div');
    counterBox.className = 'sam-bm-count';

    left.appendChild(title);
    left.appendChild(counterBox);

    head.appendChild(left);
    panel.appendChild(head);

    listBox = document.createElement('div');
    listBox.className = 'sam-bm-list';
    panel.appendChild(listBox);

    hintBox = document.createElement('div');
    hintBox.className = 'sam-bm-hint';
    hintBox.textContent = '☆ на сообщении — добавить, ★ — убрать; ✎ — переименовать';
    panel.appendChild(hintBox);

    // фон светлой темы (в тёмной — через CSS)
    const applyLightBg = () => {
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (!dark) {
        panel.style.background = 'rgba(255,255,255,.94)';
        panel.style.color = '#111';
      }
    };
    applyLightBg();
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener && mq.addEventListener('change', applyLightBg);
    }

    document.body.appendChild(panel);
    renderPanel();
  }

  function isEditingRow(row) {
    return !!row.querySelector('.sam-bm-input');
  }

  function startEditTitle(bm, row, textEl) {
    if (!row || !textEl || isEditingRow(row)) return;

    const input = document.createElement('input');
    input.className = 'sam-bm-input';
    input.type = 'text';
    input.value = (bm.title || bm.excerpt || '').trim();
    input.placeholder = 'Название закладки';

    // заменить текст на инпут
    textEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const cancel = () => {
      input.replaceWith(textEl);
    };

    const commit = () => {
      const v = (input.value || '').trim();
      const newTitle = v || (bm.excerpt || '(без текста)');

      // обновить в основном массиве по key
      const i = bookmarks.findIndex(x => x.key === bm.key);
      if (i >= 0) {
        bookmarks[i].title = newTitle;
        saveBookmarks(bookmarks);
      }

      renderPanel();
      decorateAllMessages();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener('blur', () => commit());
  }

  function renderPanel() {
    ensurePanel();

    counterBox.textContent = String(bookmarks.length);
    listBox.innerHTML = '';

    if (!bookmarks.length) {
      const empty = document.createElement('div');
      empty.style.padding = '8px 10px';
      empty.style.opacity = '.7';
      empty.textContent = 'Пока пусто';
      listBox.appendChild(empty);
      return;
    }

    const list = bookmarks.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    for (const bm of list) {
      if (!bm.title) bm.title = bm.excerpt || '(без текста)';

      const row = document.createElement('div');
      row.className = 'sam-bm-item';
      row.title = 'Клик — перейти, двойной клик — переименовать';

      const role = document.createElement('div');
      role.className = 'sam-bm-role';
      role.textContent = bm.role === 'user' ? 'U' : 'A';

      const text = document.createElement('div');
      text.className = 'sam-bm-text';
      text.textContent = bm.title || bm.excerpt || '(без текста)';

      const actions = document.createElement('div');
      actions.className = 'sam-bm-actions';

      const edit = document.createElement('button');
      edit.className = 'sam-bm-edit';
      edit.type = 'button';
      edit.textContent = '✎';
      edit.title = 'Переименовать';

      const del = document.createElement('button');
      del.className = 'sam-bm-del';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Удалить';

      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        startEditTitle(bm, row, text);
      });

      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeBookmark(bm.key);
      });

      row.addEventListener('dblclick', (e) => {
        e.preventDefault();
        startEditTitle(bm, row, text);
      });

      row.addEventListener('click', () => {
        if (isEditingRow(row)) return;
        goToBookmark(bm);
      });

      actions.appendChild(edit);
      actions.appendChild(del);

      row.appendChild(role);
      row.appendChild(text);
      row.appendChild(actions);

      listBox.appendChild(row);
    }
  }

  // ---------- message decoration ----------
  function guessRole(node) {
    const direct = node.getAttribute && node.getAttribute('data-message-author-role');
    if (direct) return direct;
    const inside = node.querySelector && node.querySelector('[data-message-author-role]');
    if (inside) return inside.getAttribute('data-message-author-role');
    return '';
  }

  function messageText(node) {
    const md = node.querySelector && (node.querySelector('.markdown') || node.querySelector('[data-message-content]'));
    const base = md || node;
    return normText(base ? base.innerText : '');
  }

  function computeKey(node, role, text, index) {
    const mid = node.getAttribute && (node.getAttribute('data-message-id') || (node.dataset && node.dataset.messageId));
    if (mid) return 'id:' + mid;
    const core = role + '|' + (text || '').slice(0, 320) + '|' + String(index || 0);
    return 'h:' + djb2Hash(core);
  }

  function isBookmarked(key) {
    return bookmarks.some(b => b.key === key);
  }

  function addOrUpdateBtn(node, key) {
    if (!node || !node.isConnected) return;

    node.classList.add('sam-bm-msgwrap');
    node.setAttribute(ATTR_KEY, key);

    let btn = node.querySelector(':scope > .sam-bm-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sam-bm-btn';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBookmark(node);
      });
      node.appendChild(btn);
    }
    btn.textContent = isBookmarked(key) ? '★' : '☆';
    btn.title = isBookmarked(key) ? 'Убрать закладку' : 'Добавить закладку';
  }

  function findMessageNodes() {
    const sels = [
      '[data-message-author-role]',
      'article',
    ];

    for (const sel of sels) {
      const nodes = Array.from(document.querySelectorAll(sel));
      const filtered = nodes.filter(n => {
        const r = guessRole(n);
        if (!r) return false;
        const t = messageText(n);
        return t.length > 0;
      });
      if (filtered.length) return filtered;
    }
    return [];
  }

  function decorateAllMessages() {
    ensurePanel();

    const nodes = findMessageNodes();
    if (!nodes.length) return;

    let idx = 0;
    for (const node of nodes) {
      idx++;

      if (node.getAttribute(ATTR_DONE) === '1') {
        const key = node.getAttribute(ATTR_KEY);
        if (key) addOrUpdateBtn(node, key);
        continue;
      }

      const role = guessRole(node);
      const text = messageText(node);

      const key = computeKey(node, role, text, idx);
      node.setAttribute(ATTR_DONE, '1');
      addOrUpdateBtn(node, key);
    }
  }

  // ---------- bookmarks ops ----------
  function toggleBookmark(node) {
    const sc = pickScroller();
    const role = guessRole(node) || 'assistant';
    const text = messageText(node);

    let key = node.getAttribute(ATTR_KEY);
    if (!key) key = computeKey(node, role, text, 0);

    if (isBookmarked(key)) {
      bookmarks = bookmarks.filter(b => b.key !== key);
      saveBookmarks(bookmarks);
      addOrUpdateBtn(node, key);
      renderPanel();
      return;
    }

    const excerpt = (text || '').slice(0, CFG.excerptLen) || '(без текста)';

    const bm = {
      key,
      role: role === 'user' ? 'user' : 'assistant',
      excerpt,
      title: excerpt, // можно переименовать
      textHash: djb2Hash(role + '|' + (text || '').slice(0, 320)),
      scrollTop: sc.getTop(),
      createdAt: Date.now(),
    };

    bookmarks.push(bm);
    saveBookmarks(bookmarks);
    addOrUpdateBtn(node, key);
    renderPanel();
  }

  function removeBookmark(key) {
    bookmarks = bookmarks.filter(b => b.key !== key);
    saveBookmarks(bookmarks);
    renderPanel();
    decorateAllMessages();
  }

  function findNodeByKey(key) {
    if (!key) return null;
    return document.querySelector('[' + ATTR_KEY + '="' + cssEscape(key) + '"]');
  }

  function highlightNode(node) {
    if (!node) return;
    node.classList.add('sam-bm-highlight');
    setTimeout(() => node.classList.remove('sam-bm-highlight'), CFG.highlightMs);
  }

  function goToBookmark(bm) {
    const sc = pickScroller();

    let node = findNodeByKey(bm.key);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightNode(node);
      return;
    }

    if (typeof bm.scrollTop === 'number') {
      sc.setTop(Math.max(0, bm.scrollTop - 20), true);
    } else {
      sc.setTop(0, true);
    }

    const targetTop = (typeof bm.scrollTop === 'number') ? bm.scrollTop : 0;
    const dir = sc.getTop() > targetTop ? -1 : 1;

    let steps = 0;
    const timer = setInterval(() => {
      node = findNodeByKey(bm.key);
      if (node) {
        clearInterval(timer);
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightNode(node);
        return;
      }

      steps++;
      if (steps > CFG.seekMaxSteps) {
        clearInterval(timer);
        hintBox.textContent = 'Не нашла сообщение в DOM. Промотай чуть вверх/вниз и попробуй снова.';
        setTimeout(() => {
          hintBox.textContent = '☆ на сообщении — добавить, ★ — убрать; ✎ — переименовать';
        }, 2500);
        return;
      }

      sc.scrollBy(dir * sc.getHeight() * CFG.seekStepViewportK, true);
    }, 250);
  }

  // ---------- navigation / observers ----------
  let mo = null;
  function installObserver() {
    if (mo) return;

    mo = new MutationObserver(() => {
      if (installObserver._t) return;
      installObserver._t = setTimeout(() => {
        installObserver._t = null;
        decorateAllMessages();
      }, 150);
    });

    mo.observe(document.body, { childList: true, subtree: true });
  }

  let lastHref = location.href;
  function handleNavChange() {
    bookmarks = loadBookmarks();
    renderPanel();
    decorateAllMessages();
  }

  function startUrlWatcher() {
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        handleNavChange();
      }
    }, CFG.urlPollMs);
  }

  // ---------- init ----------
  function init() {
    ensurePanel();
    decorateAllMessages();
    installObserver();
    startUrlWatcher();
    log('init ok');
  }

  init();
})();
