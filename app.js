/* Community Creche — schedules, sign-ups, creche count. No dependencies. */
(() => {
  'use strict';

  const SCRIPT_URL = (window.CRECHE_CONFIG && window.CRECHE_CONFIG.scriptUrl) || '';
  const POLL_MS = 45000;
  const REQUEST_TIMEOUT_MS = 20000;

  // ---------- Time grids (keep in sync with apps-script/Code.gs) ----------

  const FIRST_MIN = 12 * 60;
  const LAST_MIN = 21 * 60; // exclusive: last performance slot starts at 8:50 PM
  const STEP_MIN = 10;

  const slotLabel = (minutes) => {
    const h = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const hourName = (hour) => (hour === 12 ? 'Noon' : `${hour % 12}`);
  const hourHeading = (hour) => (hour === 12 ? 'Noon' : `${hour % 12} PM`);
  const hourBlockLabel = (hour) => `${hourName(hour)} – ${(hour + 1) % 12 || 12} PM`; // 'Noon – 1 PM', '8 – 9 PM'

  /** Performances: [{ heading: 'Noon', slots: ['12:00 PM', '12:10 PM', ...] }, ...] */
  const TIME_GROUPS = [];
  for (let m = FIRST_MIN; m < LAST_MIN; m += STEP_MIN) {
    const hour = Math.floor(m / 60);
    if (!TIME_GROUPS.length || TIME_GROUPS[TIME_GROUPS.length - 1].hour !== hour) {
      TIME_GROUPS.push({ hour, heading: hourHeading(hour), slots: [] });
    }
    TIME_GROUPS[TIME_GROUPS.length - 1].slots.push(slotLabel(m));
  }

  /** Ushers: one block per hour, noon to 9:00 PM, in a single group with no heading. */
  const USHER_GROUPS = [
    {
      heading: '',
      slots: Array.from({ length: (LAST_MIN - FIRST_MIN) / 60 }, (_, i) => hourBlockLabel(FIRST_MIN / 60 + i)),
    },
  ];

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
    const ushers = [{ slot: 'Noon – 1 PM', name: 'Sample Usher' }];
    const slotLists = { performance: performances, usher: ushers }; // payload.type -> list
    let creches = 3;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const copy = (list) => list.map((item) => ({ ...item }));
    return {
      async load() {
        await wait(400);
        return { ok: true, performances: copy(performances), ushers: copy(ushers), creches };
      },
      async send(payload) {
        await wait(600);
        const list = slotLists[payload.type];
        if (list) {
          const taken = payload.slots.filter((slot) => list.some((p) => p.slot === slot));
          if (taken.length) return { ok: false, error: 'taken', taken };
          payload.slots.forEach((slot) => list.push({ slot, name: payload.name, piece: payload.piece || '' }));
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
    creches: 0,
    signature: '',
  };

  // ---------- DOM helpers ----------

  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // textContent only: names are user-supplied
    return node;
  }

  // ---------- Schedule pickers (performances, ushers) ----------

  /**
   * Builds one schedule inside `[data-picker="<type>"]`: rows of slots, a Sign up toggle on each open row,
   * and a sticky "Continue" bar. Many slots can be chosen at once. `config` supplies the type, data key,
   * slot groups and wording; the sign-up dialog below is shared.
   */
  function createPicker(config) {
    const root = $(`[data-picker="${config.type}"]`);
    root.append($('#picker-template').content.cloneNode(true));

    const ui = {
      program: $('.program', root),
      count: $('.program-count', root),
      error: $('.program-error', root),
      empty: $('.program-empty', root),
      onlyOpen: $('.only-open', root),
      selectBar: $('.select-bar', root),
      selectSummary: $('.select-summary', root),
    };
    if (!config.filter) $('.toggle', root).hidden = true;
    ui.empty.textContent = config.strings.empty;

    const allSlots = config.groups.flatMap((g) => g.slots);
    const taken = new Map(); // slot label -> { name, piece }
    const selected = new Set(); // open slots the visitor has ticked, not yet reserved
    let onlyOpen = false;
    let firstRender = true;

    const sorted = () => allSlots.filter((s) => selected.has(s));
    const openCount = () => allSlots.filter((s) => !taken.has(s)).length;

    function paintSlotButton(button) {
      const slot = button.dataset.slot;
      const on = selected.has(slot);
      button.textContent = on ? 'Selected ✓' : 'Sign up';
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', `${on ? 'Unselect' : 'Select'} ${slot}`);
    }

    /** Update ticked buttons and the "Continue" bar without rebuilding the list (keeps keyboard focus). */
    function renderSelection() {
      ui.program.querySelectorAll('.slot-btn').forEach(paintSlotButton);
      const n = selected.size;
      ui.selectBar.hidden = n === 0;
      ui.selectSummary.textContent = n === 1 ? sorted()[0] : `${n} ${config.nouns[1]} chosen`;
    }

    function renderSlot(slot, index) {
      const entry = taken.get(slot);
      const li = el('li', `slot ${entry ? 'is-taken' : 'is-open'}${firstRender ? ' reveal' : ''}`);
      li.dataset.slot = slot;
      li.tabIndex = -1;
      li.style.setProperty('--i', index);
      li.append(el('span', 'slot-time', slot), el('span', 'leader'));

      const who = el('span', 'slot-who');
      if (!state.loaded) {
        who.append(el('span', 'skeleton'));
      } else if (entry) {
        who.append(el('span', 'slot-name', entry.name));
        if (entry.piece) who.append(el('span', 'slot-piece', entry.piece));
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
      ui.error.hidden = !state.failed;
      ui.program.hidden = state.failed;
      ui.program.replaceChildren();
      if (state.failed) {
        ui.count.textContent = '';
        return;
      }

      let index = 0;
      let shown = 0;
      for (const { heading, slots } of config.groups) {
        const visible = slots.filter((s) => !(state.loaded && onlyOpen && taken.has(s)));
        if (!visible.length) continue;
        const group = el('div', 'hour');
        if (heading) group.append(el('h3', null, heading));
        const list = el('ul', 'slots');
        for (const slot of visible) {
          list.append(renderSlot(slot, index++));
          shown++;
        }
        group.append(list);
        ui.program.append(group);
      }

      if (state.loaded) {
        const open = openCount();
        ui.count.textContent = open ? config.strings.open(open, allSlots.length) : config.strings.full(allSlots.length);
        ui.empty.hidden = shown > 0;
      } else {
        ui.count.textContent = config.strings.loading;
        ui.empty.hidden = true;
      }
      firstRender = false;
    }

    function render() {
      renderProgram();
      renderSelection();
    }

    const picker = {
      config,
      sorted,
      get size() {
        return selected.size;
      },
      render,
      renderSelection,

      /** Replace what's taken with the server's list; drop any chosen slot someone else just got. */
      setTaken(list) {
        taken.clear();
        list.forEach((p) => taken.set(p.slot, { name: p.name, piece: p.piece }));
        selected.forEach((slot) => taken.has(slot) && selected.delete(slot));
      },
      deselect(slots) {
        slots.forEach((slot) => selected.delete(slot));
      },
      /** After a successful save: show the new names right away and clear the choice. */
      reserve(slots, entry) {
        slots.forEach((slot) => taken.set(slot, entry));
        selected.clear();
      },
      focusRow(slot) {
        const row = ui.program.querySelector(`.slot[data-slot="${slot}"]`);
        if (row) row.focus();
      },
    };

    ui.program.addEventListener('click', (event) => {
      const button = event.target.closest('.slot-btn');
      if (!button) return;
      const slot = button.dataset.slot;
      if (!selected.delete(slot)) selected.add(slot);
      renderSelection();
    });
    $('.select-continue', root).addEventListener('click', () => openSignup(picker));
    $('.select-clear', root).addEventListener('click', () => {
      selected.clear();
      renderSelection();
    });
    ui.onlyOpen.addEventListener('change', () => {
      onlyOpen = ui.onlyOpen.checked;
      renderProgram();
    });
    $('.retry', root).addEventListener('click', () => {
      state.failed = false;
      render();
      refresh();
    });

    return picker;
  }

  const performances = createPicker({
    type: 'performance',
    dataKey: 'performances',
    groups: TIME_GROUPS,
    filter: true,
    nouns: ['time', 'times'],
    strings: {
      loading: 'Checking open times…',
      open: (open, total) => `${open} of ${total} times open`,
      full: (total) => `All ${total} times are taken`,
      empty: 'Every open time has been taken. Thank you, and please come listen.',
    },
    dialog: {
      lede: 'One person or group per time. Each time is 10 minutes.',
      nameLabel: 'Your name or group name',
      piece: true,
      notice: 'Your name and performance will be shown publicly on this page.',
      doneTitle: "You're on the program",
    },
  });

  const ushers = createPicker({
    type: 'usher',
    dataKey: 'ushers',
    groups: USHER_GROUPS,
    filter: false,
    nouns: ['hour', 'hours'],
    strings: {
      loading: 'Checking open hours…',
      open: (open, total) => `${open} of ${total} hours still need someone`,
      full: () => 'Every hour is covered. Thank you!',
      empty: 'Every hour is covered. Thank you!',
    },
    dialog: {
      lede: 'One person per hour. You will help make sure there is enough hot chocolate and look after the general needs of the event.',
      nameLabel: 'Your name',
      piece: false,
      notice: 'Your name will be shown publicly on this page.',
      doneTitle: 'Thank you for helping',
    },
  });

  const pickers = [performances, ushers];

  // ---------- Creche count ----------

  const crecheCountEl = $('#creche-count');

  function renderCreches() {
    const n = state.creches;
    crecheCountEl.replaceChildren();
    if (!state.loaded) {
      crecheCountEl.innerHTML = '&nbsp;';
    } else if (n === 0) {
      crecheCountEl.textContent = 'No creches promised yet. Be the first.';
    } else {
      crecheCountEl.append(el('strong', null, String(n)), ` ${n === 1 ? 'creche is' : 'creches are'} coming so far`);
    }
  }

  function render() {
    pickers.forEach((p) => p.render());
    renderCreches();
  }

  // ---------- Loading ----------

  function applyData(data) {
    const signature = JSON.stringify(data);
    if (state.loaded && signature === state.signature) return;
    state.signature = signature;
    pickers.forEach((p) => p.setTaken(data[p.config.dataKey] || []));
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
      `Someone just took ${listFormat.format(slots)}. ${slots.length === 1 ? 'It is' : 'They are'} removed from your list.`,
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

  // ---------- Slot sign-up dialog (shared by performances and ushers) ----------

  const dialog = $('#signup');
  const slotForm = $('#signup-form');
  const slotStatus = $('#signup-status');
  const slotSubmit = $('#signup-submit');
  const doneView = $('#signup-done');
  const closeButtons = dialog.querySelectorAll('[data-close]');
  const cancelButton = slotForm.querySelector('[data-close]');
  const pieceField = $('#signup-piece-field');
  const checkSlotPhone = watchPhone(slotForm.elements.phone);
  let active = null; // the picker the dialog is currently serving
  let reserved = { picker: null, slots: [] }; // what was just saved, so focus can return to its first row

  /** Show the chosen slots in the dialog and keep the heading and button in step with them. */
  function renderChosen() {
    const slots = active.sorted();
    const [one, many] = active.config.nouns;
    $('#signup-times').replaceChildren(...slots.map((slot) => el('li', null, slot)));
    $('#signup-heading').textContent = slots.length > 1 ? many : one;
    slotSubmit.textContent =
      slots.length > 1 ? `Reserve ${slots.length} ${many}` : slots.length ? `Reserve ${slots[0]}` : 'Reserve';
    slotSubmit.disabled = slots.length === 0;
  }

  function openSignup(picker) {
    if (!picker.size) return;
    active = picker;
    const text = picker.config.dialog;
    slotForm.reset();
    slotForm.hidden = false;
    doneView.hidden = true;
    $('#signup-lede').textContent = text.lede;
    $('#signup-name-label').textContent = text.nameLabel;
    $('#signup-notice').textContent = text.notice;
    $('#signup-done-title').textContent = text.doneTitle;
    pieceField.hidden = !text.piece;
    slotForm.elements.piece.disabled = !text.piece; // a disabled field is left out of the submitted values
    cancelButton.textContent = 'Cancel';
    setStatus(slotStatus, '', '');
    renderChosen();
    checkSlotPhone();
    dialog.showModal();
  }

  // After a successful sign-up, put keyboard/screen-reader focus on the first row that just got the name.
  function focusReservedRow() {
    if (doneView.hidden || !reserved.slots.length) return;
    reserved.picker.focusRow(reserved.slots[0]);
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

  slotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!slotForm.reportValidity() || slotSubmit.disabled) return;

    const picker = active;
    const values = formValues(slotForm);
    const slots = picker.sorted();
    slotSubmit.disabled = true;
    setStatus(slotStatus, '', 'Saving…');

    const name = values.name.trim();
    const piece = (values.piece || '').trim();
    const res = await send({
      type: picker.config.type,
      slots,
      name,
      phone: values.phone.trim(),
      website: values.website,
      ...(picker.config.dialog.piece && { piece }),
    });

    if (res.ok) {
      picker.reserve(slots, { name, piece });
      reserved = { picker, slots };
      state.signature = '';
      render();
      $('#done-time').textContent = listFormat.format(slots);
      $('#done-name').textContent = name;
      slotForm.hidden = true;
      doneView.hidden = false;
      $('button', doneView).focus();
      return;
    }

    if (res.error === 'taken') {
      const takenSlots = res.taken || slots;
      picker.deselect(takenSlots);
      renderChosen(); // also disables the button if nothing is left
      picker.renderSelection();
      setStatus(slotStatus, 'error', MESSAGES.taken(takenSlots));
      cancelButton.textContent = picker.size ? 'Cancel' : `Choose other ${picker.config.nouns[1]}`;
      refresh(); // pull the new schedule so the taken rows update behind the dialog
    } else {
      slotSubmit.disabled = false;
      setStatus(slotStatus, 'error', (MESSAGES[res.error] || MESSAGES.server)());
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

  // ---------- Polling ----------

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
