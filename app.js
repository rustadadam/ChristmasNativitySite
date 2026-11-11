/* Community Creche — schedule, sign-ups, creche count. No dependencies. */
(() => {
  'use strict';

  const SCRIPT_URL = (window.CRECHE_CONFIG && window.CRECHE_CONFIG.scriptUrl) || '';
  const POLL_MS = 45000;
  const REQUEST_TIMEOUT_MS = 20000;

  // ---------- Time grid (keep in sync with apps-script/Code.gs) ----------

  const FIRST_MIN = 12 * 60;
  const LAST_MIN = 21 * 60; // exclusive: last slot starts at 8:50 PM
  const STEP_MIN = 10;

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
  const ALL_SLOTS = HOURS.flatMap((h) => h.slots);
  const TOTAL_SLOTS = ALL_SLOTS.length;
  const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

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
      { slot: '2:10 PM', name: 'Sample Piano Duo', piece: '' },
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
          const taken = payload.slots.filter((slot) => performances.some((p) => p.slot === slot));
          if (taken.length) return { ok: false, error: 'taken', taken };
          payload.slots.forEach((slot) => performances.push({ slot, name: payload.name, piece: payload.piece || '' }));
        } else if (payload.type === 'creche') {
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
    selected: new Set(), // open slot labels the visitor has ticked, not yet reserved
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
    selectBar: $('#select-bar'),
    selectSummary: $('#select-summary'),
  };

  // ---------- Rendering ----------

  function openCount() {
    return TOTAL_SLOTS - HOURS.reduce((n, h) => n + h.slots.filter((s) => state.performances.has(s)).length, 0);
  }

  const sortedSelection = () => ALL_SLOTS.filter((s) => state.selected.has(s));

  function paintSlotButton(button) {
    const slot = button.dataset.slot;
    const on = state.selected.has(slot);
    button.textContent = on ? 'Selected ✓' : 'Sign up';
    button.classList.toggle('is-selected', on);
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', `${on ? 'Unselect' : 'Select'} ${slot}`);
  }

  /** Update ticked buttons and the "Continue" bar without rebuilding the list (keeps keyboard focus). */
  function renderSelection() {
    els.program.querySelectorAll('.slot-btn').forEach(paintSlotButton);
    const n = state.selected.size;
    els.selectBar.hidden = n === 0;
    els.selectSummary.textContent = n === 1 ? sortedSelection()[0] : `${n} times chosen`;
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
      const button = el('button', 'slot-btn');
      button.type = 'button';
      button.dataset.slot = slot;
      who.append(button);
      paintSlotButton(button);
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
    renderSelection();
    renderCreches();
  }

  // ---------- Loading ----------

  function applyData(data) {
    const signature = JSON.stringify(data);
    if (state.loaded && signature === state.signature) return;
    state.signature = signature;
    state.performances = new Map(data.performances.map((p) => [p.slot, { name: p.name, piece: p.piece }]));
    state.selected.forEach((slot) => state.performances.has(slot) && state.selected.delete(slot)); // someone else got it
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
    taken: (slots) =>
      `Someone just reserved ${listFormat.format(slots)}. ${slots.length === 1 ? 'It is' : 'They are'} removed from your list.`,
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
  let reserved = []; // slots just saved, so focus can return to the first one

  /** Show the chosen times in the dialog and keep the heading and button in step with them. */
  function renderChosen() {
    const slots = sortedSelection();
    const many = slots.length > 1;
    $('#signup-times').replaceChildren(...slots.map((slot) => el('li', null, slot)));
    $('#signup-heading').textContent = many ? 'times' : 'time';
    perfSubmit.textContent = many ? `Reserve ${slots.length} times` : slots.length ? `Reserve ${slots[0]}` : 'Reserve';
    perfSubmit.disabled = slots.length === 0;
  }

  function openSignup() {
    if (!state.selected.size) return;
    perfForm.reset();
    perfForm.hidden = false;
    doneView.hidden = true;
    cancelButton.textContent = 'Cancel';
    setStatus(perfStatus, '', '');
    renderChosen();
    checkPerfPhone();
    dialog.showModal();
  }

  els.program.addEventListener('click', (event) => {
    const button = event.target.closest('.slot-btn');
    if (!button) return;
    const slot = button.dataset.slot;
    if (!state.selected.delete(slot)) state.selected.add(slot);
    renderSelection();
  });
  $('#select-continue').addEventListener('click', openSignup);
  $('#select-clear').addEventListener('click', () => {
    state.selected.clear();
    renderSelection();
  });

  // After a successful sign-up, put keyboard/screen-reader focus on the first row that just got the name.
  function focusReservedRow() {
    if (doneView.hidden || !reserved.length) return;
    const row = els.program.querySelector(`.slot[data-slot="${reserved[0]}"]`);
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
    const slots = sortedSelection();
    perfSubmit.disabled = true;
    setStatus(perfStatus, '', 'Saving…');

    const res = await send({
      type: 'performance',
      slots,
      name: values.name.trim(),
      piece: values.piece.trim(),
      phone: values.phone.trim(),
      website: values.website,
    });

    if (res.ok) {
      slots.forEach((slot) => state.performances.set(slot, { name: values.name.trim(), piece: values.piece.trim() }));
      reserved = slots;
      state.selected.clear();
      state.signature = '';
      render();
      $('#done-time').textContent = listFormat.format(slots);
      $('#done-name').textContent = values.name.trim();
      perfForm.hidden = true;
      doneView.hidden = false;
      $('button', doneView).focus();
      return;
    }

    if (res.error === 'taken') {
      const taken = res.taken || slots;
      taken.forEach((slot) => state.selected.delete(slot));
      renderChosen(); // also disables the button if nothing is left
      renderSelection();
      setStatus(perfStatus, 'error', MESSAGES.taken(taken));
      cancelButton.textContent = state.selected.size ? 'Cancel' : 'Choose other times';
      refresh(); // pull the new schedule so the taken rows update behind the dialog
    } else {
      perfSubmit.disabled = false;
      setStatus(perfStatus, 'error', (MESSAGES[res.error] || MESSAGES.server)());
    }
  });

  dialog.addEventListener('close', focusReservedRow); // covers Escape and backdrop clicks

  // ---------- Pledge forms (creches, decorations) ----------

  /** Wires a simple name + phone form that posts `{ type, name, phone, ...extra(values) }`. */
  function wirePledgeForm(form, { type, extra = () => ({}), onSaved = () => {}, thanks }) {
    const status = $('.form-status', form);
    const submit = $('button[type="submit"]', form);
    const checkPhone = watchPhone(form.elements.phone);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity() || submit.disabled) return;

      const values = formValues(form);
      submit.disabled = true;
      setStatus(status, '', 'Saving…');

      const res = await send({
        type,
        name: values.name.trim(),
        phone: values.phone.trim(),
        website: values.website,
        ...extra(values),
      });

      submit.disabled = false;
      if (res.ok) {
        onSaved(values);
        form.reset();
        checkPhone();
        setStatus(status, 'ok', thanks(values));
      } else {
        setStatus(status, 'error', (MESSAGES[res.error] || MESSAGES.server)());
      }
    });
  }

  const crecheCountOf = (values) => Math.floor(Number(values.count));

  wirePledgeForm($('#creche-form'), {
    type: 'creche',
    extra: (values) => ({ count: crecheCountOf(values) }),
    onSaved: (values) => {
      state.creches += crecheCountOf(values);
      state.signature = '';
      renderCreches();
    },
    thanks: (values) => {
      const count = crecheCountOf(values);
      return `Thank you! ${count === 1 ? 'Your creche is' : `Your ${count} creches are`} counted.`;
    },
  });

  wirePledgeForm($('#decorations-form'), {
    type: 'decorations',
    extra: (values) => ({ items: values.items.trim() }),
    thanks: () => 'Thank you! See you between 8 and 11 AM on December 17.',
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
