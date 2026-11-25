// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  /** @type {any} */
  let state = saved.state;
  /** Collapsed queues, draft task text per queue, expanded results. */
  const collapsed = new Set(saved.collapsed || []);
  /** @type {Record<string, string>} */
  const drafts = saved.drafts || {};
  const open = new Set(saved.open || []);
  /** @type {string | undefined} */
  let editing; // `${queue}/${key}`

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const esc = (/** @type {unknown} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
  const svg = (/** @type {string} */ d, fill = false) =>
    `<svg viewBox="0 0 16 16" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    up: svg('<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>'),
    down: svg('<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>'),
    edit: svg('<path d="M10.5 3.5l2 2L6 12H4v-2z"/>'),
    remove: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6"/>'),
    open: svg('<path d="M9 3.5h3.5V7M12.5 3.5 7.5 8.5M11 9.5v2.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H7"/>'),
    again: svg('<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3.5v2.5H10"/>'),
    clear: svg('<path d="M3.5 4.5h9M6.5 4.5v-1h3v1M5 4.5l.5 8h5l.5-8"/>'),
    pause: svg('<rect x="4.5" y="3.5" width="2.2" height="9" rx=".5"/><rect x="9.3" y="3.5" width="2.2" height="9" rx=".5"/>', true),
    play: svg('<path d="M5 3.5v9l7-4.5z"/>', true),
    chevron: svg('<path d="M6 4l4 4-4 4"/>'),
    waiting: svg('<circle cx="8" cy="8" r="4.5"/>'),
    starting: svg('<circle cx="8" cy="8" r="4.5" stroke-dasharray="2 2"/>'),
    running: svg('<path class="spin" d="M8 3.5a4.5 4.5 0 1 1-4.5 4.5"/>'),
    done: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  };
  const btn = (/** @type {string} */ action, /** @type {string} */ icon, /** @type {string} */ title, extra = '') =>
    `<button class="icon" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon}</button>`;
  /** An idle chat whose hook waits for its next task is "ready": it starts on new tasks by itself. */
  const chatState = (/** @type {any} */ c) =>
    c.paused ? 'paused' : c.status === 'busy' ? 'working' : c.status === 'idle' ? (c.waiter ? 'ready' : 'waiting') : 'closed';
  const chatStateText = { working: 'working', ready: 'ready for tasks', waiting: 'waiting for you', paused: 'paused', closed: 'not running' };

  function persist() {
    vscode.setState({ state, collapsed: [...collapsed], drafts, open: [...open] });
  }

  function task(/** @type {any} */ q, /** @type {any} */ t, /** @type {any[]} */ waiting) {
    const id = `${q.id}/${t.key}`;
    const wi = waiting.indexOf(t);
    let tools = '';
    let meta = '';
    if (t.state === 'waiting') {
      tools =
        btn('move', I.up, 'Move up', `data-delta="-1" ${wi <= 0 ? 'disabled' : ''}`) +
        btn('move', I.down, 'Move down', `data-delta="1" ${wi === waiting.length - 1 ? 'disabled' : ''}`) +
        btn('startEdit', I.edit, 'Edit') +
        btn('remove', I.remove, 'Remove');
    } else if (t.state === 'starting') {
      meta = 'In a new chat: press Enter there to start';
      tools = btn('requeue', I.again, 'Put back in line');
    } else if (t.state === 'running') {
      meta = `Running in <a data-action="showChat" data-chat="${esc(t.chat)}">${esc(t.chatTitle)}</a>`;
      tools = btn('requeue', I.again, 'Put back in line');
    } else {
      meta = `Done by <a data-action="showChat" data-chat="${esc(t.chat)}">${esc(t.chatTitle)}</a>${t.ago ? ` · ${esc(t.ago)}` : ''}`;
      tools = (t.result ? btn('copy', I.copy, 'Copy answer') + btn('show', I.open, 'Open answer in an editor') : '') + btn('requeue', I.again, 'Run again') + btn('remove', I.remove, 'Remove');
    }
    const text =
      editing === id
        ? `<div class="edit"><textarea data-edit aria-label="Edit task">${esc(t.text)}</textarea>
            <div class="actions"><button class="btn" data-action="cancelEdit">Cancel</button><button class="btn primary" data-action="saveEdit">Save</button></div></div>`
        : `<div class="text" title="${esc(t.text)}">${esc(t.text)}</div>`;
    return `<li class="task ${t.state} ${open.has(id) ? 'open' : ''}" data-key="${esc(t.key)}">
      <div class="row"><span class="state" title="${esc(t.state)}">${I[/** @type {keyof typeof I} */ (t.state)] || ''}</span>${text}<span class="tools">${editing === id ? '' : tools}</span></div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${t.state === 'done' && t.result ? `<div class="result" data-action="toggle" title="Click to ${open.has(id) ? 'collapse' : 'expand'}">${esc(t.result)}</div>` : ''}
    </li>`;
  }

  function queue(/** @type {any} */ q) {
    const isCollapsed = collapsed.has(q.id);
    const waiting = q.tasks.filter((/** @type {any} */ t) => t.state === 'waiting');
    const done = q.tasks.some((/** @type {any} */ t) => t.state === 'done');
    const chips = q.followers
      .map((/** @type {any} */ c) => `<button class="chip ${chatState(c)}" data-action="showChat" data-chat="${esc(c.sessionId)}" title="${esc(c.title)}: ${chatStateText[/** @type {keyof typeof chatStateText} */ (chatState(c))]}"><span class="dot"></span>${esc(c.title)}</button>`)
      .join('');
    return `<article class="queue ${isCollapsed ? 'collapsed' : ''}" data-queue="${esc(q.id)}">
      <header class="qhead">
        <button class="twisty" data-action="collapse" aria-expanded="${!isCollapsed}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${I.chevron}</button>
        <div class="qtitle"><span class="qname">${esc(q.name)}</span><span class="qsum">${esc(q.summary)}</span></div>
        <span class="tools">${btn('renameQueue', I.edit, 'Rename queue')}${done ? btn('copyResults', I.copy, 'Copy all answers as Markdown') + btn('clearDone', I.clear, 'Clear finished tasks') : ''}${btn('deleteQueue', I.remove, 'Delete queue')}</span>
      </header>
      ${
        isCollapsed
          ? ''
          : `<div class="qbody">
        <div class="composer">
          <textarea data-compose rows="2" placeholder="Add a task to ${esc(q.name)}…" aria-label="New task for ${esc(q.name)}">${esc(drafts[q.id] || '')}</textarea>
          <div class="crow"><button class="btn link" data-action="snippet">Snippet…</button><span class="hint">Ctrl+Enter</span><button class="btn" data-action="add" title="Add the task (Ctrl+Enter)">Add</button></div>
        </div>
        ${q.tasks.length ? `<ol class="tasks">${q.tasks.map((/** @type {any} */ t) => task(q, t, waiting)).join('')}</ol>` : ''}
        <div class="workers">
          <span class="label">Chats</span>${chips || '<span class="none">none yet</span>'}
          <span class="spacer"></span>
          <button class="btn ${q.followers.length ? '' : 'primary'}" data-action="startChats" title="Open new Claude Code chats that work through this queue">Start chats…</button>
          <button class="btn" data-action="attachChat" title="Let a Claude Code chat that is already running work on this queue">Add a chat…</button>
        </div>
      </div>`
      }
    </article>`;
  }

  function chat(/** @type {any} */ c) {
    const st = chatState(c);
    const now = c.current
      ? `Working on <span class="cur" title="${esc(c.current.text)}">${esc(c.current.text.split('\n')[0])}</span> <span class="muted">(${esc(c.current.queueName)})</span>`
      : st === 'paused'
        ? 'Paused: finishes its task, takes no new ones'
        : st === 'ready'
          ? c.waiting
            ? 'Starting its next task…'
            : 'Ready: starts on the next task you add to its queues'
          : st === 'waiting' && c.waiting
          ? `Waiting for you · ${c.waiting} task${c.waiting === 1 ? '' : 's'} waiting <button class="btn small" data-action="nextNow" title="It finished its last turn before Switchboard's hook was in place">Give it the next task</button>`
          : st === 'closed'
            ? 'Not running. It picks up tasks again if you reopen it.'
            : c.waiting
              ? `${c.waiting} task${c.waiting === 1 ? '' : 's'} waiting`
              : 'Nothing waiting in its queues';
    const follows = c.follows
      .map(
        (/** @type {any} */ f, /** @type {number} */ i) =>
          `<span class="follow" data-queue="${esc(f.id)}"><span class="n">${i + 1}</span>${esc(f.name)}${i > 0 ? btn('moveFollow', I.up, 'Work on this queue earlier', 'data-delta="-1"') : ''}${btn('unfollow', I.remove, `Stop working on ${f.name}`)}</span>`,
      )
      .join('<span class="arrow">→</span>');
    return `<article class="chat ${st}" data-chat="${esc(c.sessionId)}">
      <div class="row"><span class="dot"></span><a class="ctitle" data-action="showChat" title="Show this chat">${esc(c.title)}</a>${c.kind ? `<span class="pill">${esc(c.kind)}</span>` : ''}
        <span class="tools">${c.paused ? btn('pause', I.play, 'Resume: take tasks again', 'data-paused="0"') : btn('pause', I.pause, 'Pause: finish the current task, take no new ones', 'data-paused="1"')}${btn('unfollow', I.remove, 'Stop working on queues')}</span></div>
      <div class="now">${now}</div>
      <div class="follows"><span class="label">Follows</span>${follows}<button class="btn link small" data-action="follow">+ queue</button></div>
    </article>`;
  }

  function render() {
    if (!state) return;
    // Re-rendering replaces the text boxes: keep what is being typed, and where.
    const active = /** @type {HTMLTextAreaElement | null} */ (document.activeElement && /** @type {HTMLElement} */ (document.activeElement).matches?.('textarea') ? document.activeElement : null);
    const focusedQueue = active?.matches('[data-compose]') ? /** @type {HTMLElement} */ (active.closest('[data-queue]')).dataset.queue : undefined;
    const editText = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('[data-edit]'))?.value;
    const sel = active ? [active.selectionStart, active.selectionEnd] : undefined;
    $('notice').innerHTML = state.unavailable ? `<div class="notice">${esc(state.unavailable)}</div>` : '';
    const top = `<div class="top"><button class="btn" data-action="newQueue" ${state.unavailable ? 'disabled' : ''}>+ New queue</button></div>`;
    $('queues').innerHTML = state.queues.length
      ? top + state.queues.map(queue).join('')
      : state.unavailable
        ? ''
        : `<div class="empty">
            <p>Make a queue of tasks, then let Claude Code chats work through it: each time Claude finishes a task, it takes the next one.</p>
            <p>Several chats can share a queue, and a chat can follow several queues one after another, keeping its context.</p>
            <button class="btn primary" data-action="newQueue">+ New queue</button>
          </div>`;
    $('chats').innerHTML = state.chats.length ? `<h2 class="section">Chats</h2>${state.chats.map(chat).join('')}` : '';
    const edit = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('[data-edit]'));
    if (edit && editText !== undefined) edit.value = editText;
    const again = focusedQueue
      ? /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`[data-queue="${CSS.escape(focusedQueue)}"] [data-compose]`))
      : active?.matches('[data-edit]')
        ? edit
        : null;
    if (again && sel) {
      again.focus();
      again.setSelectionRange(sel[0], sel[1]);
    }
  }

  document.addEventListener('input', (e) => {
    const ta = /** @type {HTMLTextAreaElement} */ (e.target);
    if (!ta.matches('[data-compose]')) return;
    drafts[/** @type {HTMLElement} */ (ta.closest('[data-queue]')).dataset.queue || ''] = ta.value;
    persist();
  });
  document.addEventListener('keydown', (e) => {
    const ta = /** @type {HTMLTextAreaElement} */ (e.target);
    if (ta.matches?.('[data-compose]') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit(/** @type {HTMLElement} */ (ta.closest('[data-queue]')).dataset.queue || '');
    }
  });

  function submit(/** @type {string} */ queue) {
    const text = (drafts[queue] || '').trim();
    if (text) vscode.postMessage({ type: 'add', queue, text });
  }

  document.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'));
    if (!el || /** @type {HTMLButtonElement} */ (el).disabled) return;
    const action = el.dataset.action || '';
    const q = /** @type {HTMLElement | null} */ (el.closest('[data-queue]'))?.dataset.queue;
    const key = /** @type {HTMLElement | null} */ (el.closest('[data-key]'))?.dataset.key;
    const chatId = el.dataset.chat || /** @type {HTMLElement | null} */ (el.closest('[data-chat]'))?.dataset.chat;
    const id = `${q}/${key}`;
    switch (action) {
      case 'collapse':
        if (q) collapsed.has(q) ? collapsed.delete(q) : collapsed.add(q);
        persist();
        return render();
      case 'toggle':
        open.has(id) ? open.delete(id) : open.add(id);
        persist();
        return render();
      case 'add':
        return q && submit(q);
      case 'startEdit':
        editing = id;
        render();
        /** @type {HTMLTextAreaElement | null} */ (document.querySelector('[data-edit]'))?.focus();
        return;
      case 'cancelEdit':
        editing = undefined;
        return render();
      case 'saveEdit': {
        const ta = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('[data-edit]'));
        if (ta) vscode.postMessage({ type: 'edit', queue: q, key, text: ta.value });
        editing = undefined;
        return render();
      }
      default:
        vscode.postMessage({ type: action, queue: q, key, chat: chatId, delta: Number(el.dataset.delta || 0), paused: el.dataset.paused === '1' });
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      state = m.state;
      if (editing && !state.queues.some((/** @type {any} */ q) => q.tasks.some((/** @type {any} */ t) => `${q.id}/${t.key}` === editing && t.state === 'waiting'))) editing = undefined;
      persist();
      render();
    } else if (m.type === 'clear') {
      drafts[m.queue] = '';
      persist();
      const ta = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`[data-queue="${CSS.escape(m.queue)}"] [data-compose]`));
      if (ta) ta.value = '';
    } else if (m.type === 'insert') {
      const ta = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`[data-queue="${CSS.escape(m.queue)}"] [data-compose]`));
      const cur = drafts[m.queue] || '';
      drafts[m.queue] = cur ? `${cur}\n${m.text}` : m.text;
      if (ta) {
        ta.value = drafts[m.queue];
        ta.focus();
      }
      persist();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
