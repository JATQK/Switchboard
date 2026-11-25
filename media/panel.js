// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  let state = (vscode.getState() || {}).state;

  const STALE_MS = 30 * 60 * 1000;
  /** Usage of an account with running chats goes out of date faster. */
  const BUSY_STALE_MS = 10 * 60 * 1000;
  const SOURCES = {
    statusline: 'From the Claude Code status line',
    cache: "From Claude Code's usage cache",
    limit: 'A chat on this account hit this limit',
  };
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (/** @type {unknown} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  const MORE_ICON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/></svg>';

  function duration(/** @type {number} */ ms) {
    if (!isFinite(ms) || ms < 60000) return '<1m';
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return mm ? `${h}h ${mm}m` : `${h}h`;
    return `${mm}m`;
  }

  const ago = (/** @type {number} */ ts) => (Date.now() - ts < 45000 ? 'just now' : `${duration(Date.now() - ts)} ago`);

  function untilReset(/** @type {string | undefined} */ iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    return t <= Date.now() ? 'now' : duration(t - Date.now());
  }

  function level(/** @type {number} */ pct, /** @type {number} */ threshold) {
    if (pct >= threshold) return 'hot';
    if (pct >= threshold - 15) return 'warn';
    return '';
  }

  function meter(/** @type {string} */ name, /** @type {any} */ w, /** @type {number} */ threshold, /** @type {boolean} */ auto) {
    const pct = w ? Math.round(w.pct) : undefined;
    const lv = pct === undefined ? '' : level(pct, threshold);
    const reset = w && w.pct > 0 ? untilReset(w.resetsAt) : '';
    const resetTitle = w && w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : '';
    return `<div class="meter">
      <span class="k">${name}</span>
      <div class="bar" role="progressbar" aria-label="${name} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct ?? 0}">
        <div class="fill ${lv}" style="width:${pct ?? 0}%"></div>
        ${auto ? `<div class="tick" style="left:${threshold}%" title="Auto-switch at ${threshold}%"></div>` : ''}
      </div>
      <span class="v ${lv}">${pct === undefined ? '–' : pct + '%'}</span>
      <span class="r" title="${esc(resetTitle)}">${reset ? '↻ ' + reset : ''}</span>
    </div>`;
  }

  function card(/** @type {any} */ a, /** @type {number} */ i, /** @type {number} */ count) {
    const auto = state.auto;
    const loggedOut = a.loggedIn === false;
    const classes = ['card', a.active ? 'active' : '', a.excluded ? 'excluded' : '', loggedOut ? 'loggedout' : ''].join(' ');
    const sub = [a.email, a.organizationName && a.organizationName !== a.email ? a.organizationName : ''].filter(Boolean).join(' · ');

    const chats = a.chats || 0;
    const active = state.accounts.find((/** @type {any} */ x) => x.active);
    /** @type {string[]} */
    const notes = [];
    if (chats) {
      const n = chats === 1 ? '1 chat' : `${chats} chats`;
      notes.push(
        a.active || !active
          ? `<span title="Claude Code chats running on this account">${n} running</span>`
          : `<span title="A running chat keeps the account it started with">${n} still on this account</span> · <a data-action="moveChats" title="Ends each chat's process once it is idle; it continues the same conversation on ${esc(active.label)}">Move to ${esc(active.label)}</a>`,
      );
    }
    if (loggedOut) {
      notes.unshift(`Not logged in.${a.isDefault ? ' This is the account Claude Code uses without Switchboard.' : ''}`);
    } else if (!a.usageAt) {
      notes.push(chats ? 'No usage seen yet' : "No usage seen yet. It appears once Claude Code reports this account's usage.");
    } else if (Date.now() - a.usageAt > (chats ? BUSY_STALE_MS : STALE_MS)) {
      notes.push(`<span title="${esc(SOURCES[/** @type {keyof typeof SOURCES} */ (a.usageSource)] || '')}">Usage as of ${ago(a.usageAt)}</span>`);
    }
    const note = notes.length ? `<div class="note">${notes.join(' · ')}</div>` : '';

    const tags = [
      a.plan ? `<span class="pill muted">${esc(a.plan)}</span>` : '',
      a.excluded ? `<span class="pill muted" title="Auto-switch never picks this account">skipped</span>` : '',
    ].join('');

    // Read by VS Code for the native context menu (see "webview/context" in package.json).
    const context = JSON.stringify({
      webviewSection: 'account',
      accountId: a.id,
      sbCanMoveUp: i > 0,
      sbCanMoveDown: i < count - 1,
      sbExcluded: !!a.excluded,
      sbIsDefault: !!a.isDefault,
      sbHasMovableChats: !a.active && chats > 0,
      preventDefaultContextMenuItems: true,
    });

    const action = a.active
      ? `<span class="pill live" title="New Claude Code sessions use this account">Active</span>`
      : loggedOut
        ? `<button class="btn primary" data-action="login">Log in</button>`
        : `<button class="btn" data-action="switch">Switch</button>`;

    return `<article class="${classes}" data-id="${esc(a.id)}" data-vscode-context="${esc(context)}">
      <div class="head">
        <div class="who">
          <div class="name"><span class="label" title="${esc(a.configDir)}">${esc(a.label)}</span>${tags}</div>
          ${sub ? `<div class="email" title="${esc(sub)}">${esc(sub)}</div>` : ''}
        </div>
        <button class="icon more" data-menu title="More actions" aria-label="More actions for ${esc(a.label)}">${MORE_ICON}</button>
        ${action}
      </div>
      ${
        loggedOut
          ? ''
          : `<div class="meters">
        ${meter('Session', a.session, auto.sessionThreshold, auto.enabled)}
        ${meter('Weekly', a.weekly, auto.weeklyThreshold, auto.enabled)}
      </div>`
      }
      ${note}
    </article>`;
  }

  function render() {
    if (!state) return;
    const auto = state.auto;
    const strategy =
      { priority: 'by list order', soonestWeeklyReset: 'to the soonest weekly reset' }[/** @type {string} */ (auto.strategy)] ||
      'to the most headroom';
    $('auto').innerHTML = `
      <button class="toggle" role="switch" aria-checked="${auto.enabled}" aria-label="Auto-switch" data-action="toggleAuto"></button>
      <div class="text" title="Switches ${strategy} when the active account reaches a threshold">
        <div class="title">Auto-switch ${auto.enabled ? 'on' : 'off'}</div>
        <div class="sub">at ${auto.sessionThreshold}% session · ${auto.weeklyThreshold}% weekly · <a data-action="settings">edit</a></div>
      </div>`;

    $('banner').innerHTML = state.showLiveUsageBanner
      ? `<div class="banner">
          <span><b>Live usage</b>: let Claude Code terminal chats report usage after every reply, through a small status line. Panel chats can't report it, so without it usage updates when Claude Code refreshes its own cache, or when a chat hits a limit.</span>
          <div class="banner-actions"><button class="btn primary" data-action="liveOn">Turn on</button><button class="btn" data-action="liveDismiss">Not now</button></div>
        </div>`
      : '';

    const n = state.accounts.length;
    const onlyDefaultLoggedOut = n === 1 && state.accounts[0].loggedIn === false;
    $('list').innerHTML =
      state.accounts.map((/** @type {any} */ a, /** @type {number} */ i) => card(a, i, n)).join('') +
      (n === 1
        ? `<div class="empty">
            <p>${onlyDefaultLoggedOut ? 'Log in to Claude Code first, then add' : 'Add'} your other Claude accounts to switch between them in one click.</p>
            <button class="btn primary" data-action="loginNew">Add an account…</button>
          </div>`
        : '');

    const updated = state.lastRefresh ? ago(state.lastRefresh) : 'never';
    $('footer').innerHTML = `
      <span>${state.refreshing ? '<span class="spin">↻</span> Reading usage…' : `Updated ${updated}`}</span>
      <span><a data-action="add" title="Add an account">+ Add</a> · <a data-action="terminal" title="New Claude terminal with the active account">Terminal</a> · <a data-action="refresh">Refresh</a> · <a data-action="log">Log</a></span>`;
  }

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    // The "⋯" button opens the same native menu as right-clicking the card.
    const menuBtn = target.closest('[data-menu]');
    if (menuBtn) {
      e.preventDefault();
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      menuBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left, clientY: r.bottom }));
      return;
    }
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-action]'));
    if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return;
    const cardEl = /** @type {HTMLElement | null} */ (el.closest('[data-id]'));
    vscode.postMessage({ type: el.dataset.action, id: cardEl ? cardEl.dataset.id : undefined });
  });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      vscode.setState({ state });
      render();
    }
  });

  setInterval(render, 30000);
  render();
  vscode.postMessage({ type: 'ready' });
})();
