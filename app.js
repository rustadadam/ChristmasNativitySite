/* Community Creche — schedule, sign-ups, creche count. No dependencies. */
(() => {
  'use strict';

  const SCRIPT_URL = (window.CRECHE_CONFIG && window.CRECHE_CONFIG.scriptUrl) || '';
  const POLL_MS = 45000;
  const REQUEST_TIMEOUT_MS = 20000;

  // ---------- Time grid (keep in sync with apps-script/Code.gs) ----------

  const FIRST_MIN = 12 * 60;
  const LAST_MIN = 21 * 60; // exclusive: last slot starts at 8:45 PM
  const STEP_MIN = 15;

  const slotLabel = (minutes) => {
    const h = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const hourHeading = (hour) => (hour === 12 ? 'Noon' : `${hour % 12} PM`);

  /** [{ heading: 'Noon', slots: ['12:00 PM', ...] }, ...] */
  const HOURS = [];
  for (let m = FIRST_MIN; m < LAST_MIN; m += STEP_MIN) {
    const hour = Math.floor(m / 60);
    if (!HOURS.length || HOURS[HOURS.length - 1].hour !== hour) {
      HOURS.push({ hour, heading: hourHeading(hour), slots: [] });
    }
    HOURS[HOURS.length - 1].slots.push(slotLabel(m));
  }
  const TOTAL_SLOTS = HOURS.reduce((n, h) => n + h.slots.length, 0);

  // ---------- Data layer: real backend, or in-memory preview when no URL is configured ----------

  const remoteApi = {
    async request(options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(SCRIPT_URL, { ...options, signal: controller.signal });
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
    load() {
      return this.request({ cache: 'no-store' });
    },
    send(payload) {
      // text/plain keeps this a "simple" request, so the browser skips a CORS preflight Apps Script can't answer.
      return this.request({
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
    },
  };

  const previewApi = (() => {
    const performances = [
      { slot: '12:00 PM', name: 'Sample Family Choir', piece: 'Joy to the World' },
      { slot: '12:30 PM', name: 'Sample Soloist', piece: 'Violin: Silent Night' },
      { slot: '2:15 PM', name: 'Sample Piano Duo', piece: '' },
      { slot: '6:00 PM', name: 'Sample Youth Group', piece: 'Away in a Manger' },
    ];
    let creches = 3;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    return {
      async load() {
        await wait(400);
        return { ok: true, performances: performances.map((p) => ({ ...p })), creches };
      },
      async send(payload) {
        await wait(600);
        if (payload.type === 'performance') {
          if (performances.some((p) => p.slot === payload.slot)) return { ok: false, error: 'taken' };
          performances.push({ slot: payload.slot, name: payload.name, piece: payload.piece || '' });
        } else {
          creches += Number(payload.count) || 0;
        }
        return { ok: true };
      },
    };
  })();

  const api = SCRIPT_URL ? remoteApi : previewApi;

  // ---------- State ----------

  const state = {
    loaded: false,
    failed: false,
    performances: new Map(), // slot label -> { name, piece }
    creches: 0,
    onlyOpen: false,
    signature: '',
    firstRender: true,
  };

  // ---------- DOM helpers ----------

  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // textContent only: names are user-supplied
    return node;
  }

  const els = {
    program: $('#program'),
    count: $('#program-count'),
    error: $('#program-error'),
    empty: $('#program-empty'),
    onlyOpen: $('#only-open'),
    crecheCount: $('#creche-count'),
  };

  // ---------- Rendering ----------

  function openCount() {
    return TOTAL_SLOTS - HOURS.reduce((n, h) => n + h.slots.filter((s) => state.performances.has(s)).length, 0);
  }

  function renderSlot(slot, index) {
    const taken = state.performances.get(slot);
    const li = el('li', `slot ${taken ? 'is-taken' : 'is-open'}${state.firstRender ? ' reveal' : ''}`);
    li.dataset.slot = slot;
    li.tabIndex = -1;
    li.style.setProperty('--i', index);
    li.append(el('span', 'slot-time', slot), el('span', 'leader'));

    const who = el('span', 'slot-who');
    if (!state.loaded) {
      who.append(el('span', 'skeleton'));
    } else if (taken) {
      who.append(el('span', 'slot-name', taken.name));
      if (taken.piece) who.append(el('span', 'slot-piece', taken.piece));
    } else {
      const button = el('button', 'slot-btn', 'Sign up');
      button.type = 'button';
      button.dataset.slot = slot;
      button.setAttribute('aria-label', `Sign up for ${slot}`);
      who.append(button);
    }
    li.append(who);
    return li;
  }

  function renderProgram() {
    els.error.hidden = !state.failed;
    els.program.hidden = state.failed;
    els.program.replaceChildren();
    if (state.failed) {
      els.count.textContent = '';
      return;
    }

    let index = 0;
    let shown = 0;
    for (const { heading, slots } of HOURS) {
      const visible = slots.filter((s) => !(state.loaded && state.onlyOpen && state.performances.has(s)));
      if (!visible.length) continue;
      const group = el('div', 'hour');
      group.append(el('h3', null, heading));
      const list = el('ul', 'slots');
      for (const slot of visible) {
        list.append(renderSlot(slot, index++));
        shown++;
      }
      group.append(list);
      els.program.append(group);
    }

    if (state.loaded) {
      const open = openCount();
      els.count.textContent = open
        ? `${open} of ${TOTAL_SLOTS} times open`
        : `All ${TOTAL_SLOTS} times are taken`;
      els.empty.hidden = shown > 0;
    } else {
      els.count.textContent = 'Checking open times…';
      els.empty.hidden = true;
    }
    state.firstRender = false;
  }

  function renderCreches() {
    const n = state.creches;
    els.crecheCount.replaceChildren();
    if (!state.loaded) {
      els.crecheCount.innerHTML = '&nbsp;';
    } else if (n === 0) {
      els.crecheCount.textContent = 'No creches promised yet. Be the first.';
    } else {
      els.crecheCount.append(el('strong', null, String(n)), ` ${n === 1 ? 'creche is' : 'creches are'} coming so far`);
    }
  }

  function render() {
    renderProgram();
    renderCreches();
  }

  // ---------- Loading ----------

  function applyData(data) {
    const signature = JSON.stringify(data);
    if (state.loaded && signature === state.signature) return;
    state.signature = signature;
    state.performances = new Map(data.performances.map((p) => [p.slot, { name: p.name, piece: p.piece }]));
    state.creches = Number(data.creches) || 0;
    state.loaded = true;
    state.failed = false;
    render();
  }

  async function refresh() {
    try {
      const data = await api.load();
      if (!data || !data.ok) throw new Error('bad response');
      applyData(data);
    } catch (err) {
      // A failed background refresh keeps showing the last good data; only a failed first load shows the error.
      if (!state.loaded) {
        state.failed = true;
        render();
      }
    }
  }

  // ---------- Form plumbing ----------

  const MESSAGES = {
    taken: (slot) => `Someone just reserved ${slot}. Pick another open time.`,
    network: () => "We couldn't reach the server. Check your connection and try again.",
    busy: () => 'Lots of people are signing up right now. Wait a few seconds and try again.',
    invalid: () => "Something in the form isn't valid. Check each field and try again.",
    server: () => 'Something went wrong on our end. Try again in a moment.',
  };

  const digitCount = (value) => value.replace(/\D/g, '').length;

  function watchPhone(input) {
    const check = () => {
      const digits = digitCount(input.value);
      input.setCustomValidity(
        digits >= 10 && digits <= 15 ? '' : 'Enter a phone number with area code, like (801) 555-0123.'
      );
    };
    input.addEventListener('input', check);
    check();
    return check; // call again after form.reset()
  }

  function setStatus(node, kind, message) {
    node.textContent = message;
    node.className = `form-status${kind ? ` is-${kind}` : ''}`;
  }

  /** Sends payload, returns the response, never throws. */
  async function send(payload) {
    try {
      const res = await api.send(payload);
      return res && typeof res.ok === 'boolean' ? res : { ok: false, error: 'server' };
    } catch (err) {
      return { ok: false, error: 'network' };
    }
  }

  const formValues = (form) => Object.fromEntries(new FormData(form));

  // ---------- Performance sign-up dialog ----------

  const dialog = $('#signup');
  const perfForm = $('#signup-form');
  const perfStatus = $('#signup-status');
  const perfSubmit = $('#signup-submit');
  const doneView = $('#signup-done');
  const closeButtons = dialog.querySelectorAll('[data-close]');
  const cancelButton = perfForm.querySelector('[data-close]');
  const checkPerfPhone = watchPhone(perfForm.elements.phone);

  function openSignup(slot) {
    perfForm.reset();
    perfForm.hidden = false;
    doneView.hidden = true;
    perfForm.elements.slot.value = slot;
    $('#signup-time').textContent = slot;
    perfSubmit.textContent = `Reserve ${slot}`;
    perfSubmit.disabled = false;
    cancelButton.textContent = 'Cancel';
    setStatus(perfStatus, '', '');
    checkPerfPhone();
    dialog.showModal();
  }

  els.program.addEventListener('click', (event) => {
    const button = event.target.closest('.slot-btn');
    if (button) openSignup(button.dataset.slot);
  });

  // After a successful sign-up, put keyboard/screen-reader focus on the row that just got the name.
  function focusReservedRow() {
    if (doneView.hidden) return;
    const row = els.program.querySelector(`.slot[data-slot="${perfForm.elements.slot.value}"]`);
    if (row) row.focus();
  }

  closeButtons.forEach((b) =>
    b.addEventListener('click', () => {
      dialog.close();
      focusReservedRow();
    })
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // click on the backdrop
  });

  perfForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!perfForm.reportValidity() || perfSubmit.disabled) return;

    const values = formValues(perfForm);
    perfSubmit.disabled = true;
    setStatus(perfStatus, '', 'Saving…');

    const res = await send({
      type: 'performance',
      slot: values.slot,
      name: values.name.trim(),
      piece: values.piece.trim(),
      phone: values.phone.trim(),
      website: values.website,
    });

    if (res.ok) {
      state.performances.set(values.slot, { name: values.name.trim(), piece: values.piece.trim() });
      state.signature = '';
      render();
      $('#done-time').textContent = values.slot;
      $('#done-name').textContent = values.name.trim();
      perfForm.hidden = true;
      doneView.hidden = false;
      $('button', doneView).focus();
      return;
    }

    const message = (MESSAGES[res.error] || MESSAGES.server)(values.slot);
    setStatus(perfStatus, 'error', message);
    if (res.error === 'taken') {
      cancelButton.textContent = 'Choose another time';
      refresh(); // pull the new schedule so the taken row updates behind the dialog
    } else {
      perfSubmit.disabled = false;
    }
  });

  dialog.addEventListener('close', focusReservedRow); // covers Escape and backdrop clicks

  // ---------- Creche form ----------

  const crecheForm = $('#creche-form');
  const crecheStatus = $('#creche-status');
  const crecheSubmit = $('button[type="submit"]', crecheForm);
  const checkCrechePhone = watchPhone(crecheForm.elements.phone);

  crecheForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!crecheForm.reportValidity() || crecheSubmit.disabled) return;

    const values = formValues(crecheForm);
    const count = Math.floor(Number(values.count));
    crecheSubmit.disabled = true;
    setStatus(crecheStatus, '', 'Saving…');

    const res = await send({
      type: 'creche',
      name: values.name.trim(),
      count,
      phone: values.phone.trim(),
      website: values.website,
    });

    crecheSubmit.disabled = false;
    if (res.ok) {
      state.creches += count;
      state.signature = '';
      renderCreches();
      crecheForm.reset();
      checkCrechePhone();
      setStatus(
        crecheStatus,
        'ok',
        `Thank you! ${count === 1 ? 'Your creche is' : `Your ${count} creches are`} counted.`
      );
    } else {
      setStatus(crecheStatus, 'error', (MESSAGES[res.error] || MESSAGES.server)());
    }
  });

  // ---------- Filters, retry, polling ----------

  els.onlyOpen.addEventListener('change', () => {
    state.onlyOpen = els.onlyOpen.checked;
    renderProgram();
  });

  $('#retry').addEventListener('click', () => {
    state.failed = false;
    render();
    refresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !dialog.open) refresh();
  }, POLL_MS);

  // ---------- Go ----------

  if (!SCRIPT_URL) $('#preview-note').hidden = false;
  render();
  refresh();
})();
