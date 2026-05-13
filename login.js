// login.js — Operator login / signup logic
// Handles: select operator → PIN entry → verify → redirect to app
//          create operator → name + color + PIN → save → redirect to app

import { getValidTraderSession, setTraderSession } from './auth-session.js';

// ── API helpers ────────────────────────────────────────────────────────────────

const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// When Netlify Functions aren't available locally, fall back to a mock store in
// localStorage so the page works without a deployed backend during development.
const USE_MOCK = IS_LOCAL;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_PIN_ERROR = 'Incorrect PIN. Please try again.';

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Mock backend (localStorage) used in local dev without Netlify Functions ──

function mockGetTraders() {
  return JSON.parse(localStorage.getItem('_mock_traders') || '[]');
}

function mockSaveTraders(traders) {
  localStorage.setItem('_mock_traders', JSON.stringify(traders));
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchTraders() {
  if (USE_MOCK) {
    const traders = mockGetTraders();
    const orgName = localStorage.getItem('_mock_org_name') || null;
    return { traders, firstRun: traders.length === 0, orgName };
  }
  return apiFetch('/api/traders');
}

async function createTrader(name, color, pin, role = 'trader', orgName = null) {
  if (USE_MOCK) {
    const traders = mockGetTraders();
    if (traders.find(t => t.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('An operator with this name already exists.');
    }
    const trader = {
      id:         crypto.randomUUID(),
      name,
      color,
      pin_hash:   await sha256(pin),
      role,
      created_at: new Date().toISOString(),
      active:     1,
    };
    mockSaveTraders([...traders, trader]);
    if (orgName) localStorage.setItem('_mock_org_name', orgName);
    return { id: trader.id, name: trader.name, color: trader.color, role: trader.role };
  }
  return apiFetch('/api/traders', {
    method: 'POST',
    body: JSON.stringify({ name, color, pin, role, orgName }),
  });
}

async function verifyPin(id, pin) {
  if (USE_MOCK) {
    const traders = mockGetTraders();
    const t = traders.find(tr => tr.id === id);
    if (!t) return false;
    const lockedUntil = Date.parse(t.locked_until || '');
    if (!Number.isNaN(lockedUntil) && lockedUntil > Date.now()) {
      const minutes = Math.ceil((lockedUntil - Date.now()) / 60000);
      throw new Error(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    if (!Number.isNaN(lockedUntil)) {
      t.failed_attempts = 0;
      t.locked_until = null;
    }
    const hash = await sha256(pin);
    if (hash === t.pin_hash) {
      t.failed_attempts = 0;
      t.locked_until = null;
      mockSaveTraders(traders);
      return true;
    }
    t.failed_attempts = Number(t.failed_attempts || 0) + 1;
    if (t.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      t.locked_until = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
      mockSaveTraders(traders);
      throw new Error('Too many failed attempts. Try again in 5 minutes.');
    }
    mockSaveTraders(traders);
    return false;
  }
  const res = await apiFetch('/api/traders?verify=1', {
    method: 'POST',
    body: JSON.stringify({ id, pin }),
  });
  return res.ok === true;
}

// ── State ──────────────────────────────────────────────────────────────────────

let operators   = [];       // full list loaded from backend
let selectedOp  = null;     // operator the user clicked
let pinBuffer   = '';       // digits entered on the numpad
let loginPath   = 'op';     // 'org' | 'op' — which type was chosen on landing

// ── DOM refs ──────────────────────────────────────────────────────────────────

const card       = document.getElementById('login-card');
const screens    = {
  landing: document.getElementById('screen-landing'),
  setup:   document.getElementById('screen-setup'),
  select:  document.getElementById('screen-select'),
  pin:     document.getElementById('screen-pin'),
  create:  document.getElementById('screen-create'),
};

// select screen
const operatorList = document.getElementById('operator-list');
const btnGoCreate  = document.getElementById('btn-go-create');

// pin screen
const pinBack    = document.getElementById('pin-back');
const pinName    = document.getElementById('pin-name');
const pinAvatar  = document.getElementById('pin-avatar');
const pinDots    = document.querySelectorAll('.pin-dot');
const pinError   = document.getElementById('pin-error');
const numpadKeys = document.querySelectorAll('.numpad-key[data-digit]');
const numpadClear   = document.getElementById('numpad-clear');
const numpadConfirm = document.getElementById('numpad-confirm');

// create screen
const createBack        = document.getElementById('create-back');
const createForm        = document.getElementById('create-form');
const createAvatar      = document.getElementById('create-avatar');
const swatches          = document.querySelectorAll('.swatch');
const createName        = document.getElementById('create-name');
const createPin         = document.getElementById('create-pin');
const createPinConfirm  = document.getElementById('create-pin-confirm');
const createError       = document.getElementById('create-error');
const createSubmit      = document.getElementById('create-submit');
const createBtnLabel    = document.getElementById('create-btn-label');
const createSpinner     = document.getElementById('create-spinner');
const pinToggleCreate   = document.getElementById('pin-toggle-create');
const pinToggleConfirm  = document.getElementById('pin-toggle-confirm');

// ── Screen navigation ─────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name !== 'pin') { pinBuffer = ''; renderPinDots(); }
  if (name !== 'create') clearCreateErrors();
  if (name === 'pin') pinError.classList.add('hidden');

  const orgHeader = document.getElementById('card-org-header');
  if (orgHeader) {
    const showHeader = (name === 'landing' || name === 'select' || name === 'pin') && !!localStorage.getItem('orgName');
    orgHeader.classList.toggle('hidden', !showHeader);
  }
}

// ── Operator list ─────────────────────────────────────────────────────────────

function getInitial(name) {
  return name.trim().charAt(0).toUpperCase();
}

function roleBadgeHtml(role) {
  if (role === 'owner')   return `<div class="operator-role-badge owner">Owner</div>`;
  if (role === 'senior')  return `<div class="operator-role-badge senior">Senior</div>`;
  if (role === 'monitor') return `<div class="operator-role-badge monitor">Monitor</div>`;
  return `<div class="operator-meta">PIN required</div>`;
}

function renderOperatorList(list) {
  if (list.length === 0) {
    operatorList.innerHTML = `<div class="empty-operators">No operators yet.<br>Create the first profile to get started.</div>`;
    return;
  }
  operatorList.innerHTML = '';
  list.forEach(op => {
    const card = document.createElement('button');
    card.className = 'operator-card';
    card.innerHTML = `
      <div class="operator-avatar" style="background:${op.color}">${getInitial(op.name)}</div>
      <div class="operator-info">
        <div class="operator-name">${op.name}</div>
        ${roleBadgeHtml(op.role)}
      </div>
      <span class="operator-arrow">›</span>
    `;
    card.addEventListener('click', () => openPinScreen(op));
    operatorList.appendChild(card);
  });
}

function applyOrgName(orgName) {
  if (!orgName) return;
  localStorage.setItem('orgName', orgName);
  const nameEl    = document.getElementById('card-org-name');
  const monogram  = document.getElementById('card-org-monogram');
  const header    = document.getElementById('card-org-header');
  if (nameEl)   nameEl.textContent    = orgName;
  if (monogram) monogram.textContent  = orgName.trim().charAt(0).toUpperCase();
  // Show header if already on a screen that should display it
  if (header) {
    const active = Object.entries(screens).find(([, el]) => el.classList.contains('active'));
    if (active && (active[0] === 'select' || active[0] === 'pin')) {
      header.classList.remove('hidden');
    }
  }
}

function renderFilteredOperators() {
  const filtered = loginPath === 'org'
    ? operators.filter(o => o.role === 'owner')
    : operators.filter(o => o.role !== 'owner');
  renderOperatorList(filtered);
}

function openLoginPath(path) {
  loginPath = path;
  const titleEl    = document.getElementById('select-title');
  const subtitleEl = document.getElementById('select-subtitle');
  if (path === 'org') {
    if (titleEl)    titleEl.textContent    = 'Organisation Login';
    if (subtitleEl) subtitleEl.textContent = 'Select an owner account to continue';
  } else {
    if (titleEl)    titleEl.textContent    = 'Operator Login';
    if (subtitleEl) subtitleEl.textContent = 'Select your trading profile to continue';
  }
  renderFilteredOperators();
  showScreen('select');
}

async function loadOperators() {
  try {
    const res = await fetchTraders();
    operators = res.traders ?? res;
    applyOrgName(res.orgName);
    if (res.firstRun) {
      showScreen('setup');
      return;
    }
    showScreen('landing');
  } catch (e) {
    showScreen('landing');
    const grid = document.querySelector('.login-type-grid');
    if (grid) grid.insertAdjacentHTML('beforebegin', `<p class="form-error" style="text-align:center">Failed to load — ${e.message}</p>`);
  }
}

// ── PIN screen ────────────────────────────────────────────────────────────────

function openPinScreen(op) {
  selectedOp = op;
  pinName.textContent = op.name;
  pinAvatar.textContent = getInitial(op.name);
  pinAvatar.style.background = op.color;
  pinBuffer = '';
  renderPinDots();
  pinError.classList.add('hidden');
  showScreen('pin');
}

function renderPinDots() {
  pinDots.forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinBuffer.length);
    dot.classList.remove('error');
  });
}

function shakePin() {
  pinDots.forEach(d => {
    d.classList.remove('filled');
    d.classList.add('error');
  });
  setTimeout(() => { pinBuffer = ''; renderPinDots(); }, 600);
}

async function submitPin() {
  if (pinBuffer.length < 4) return;
  numpadConfirm.disabled = true;

  try {
    const ok = await verifyPin(selectedOp.id, pinBuffer);
    if (ok) {
      setTraderSession(selectedOp);
      window.location.replace('index.html');
    } else {
      pinError.textContent = DEFAULT_PIN_ERROR;
      pinError.classList.remove('hidden');
      shakePin();
      numpadConfirm.disabled = false;
    }
  } catch (e) {
    pinError.textContent = e.message || 'Verification failed.';
    pinError.classList.remove('hidden');
    shakePin();
    numpadConfirm.disabled = false;
  }
}

// Numpad events
numpadKeys.forEach(btn => {
  btn.addEventListener('click', () => {
    if (pinBuffer.length >= 6) return;
    pinBuffer += btn.dataset.digit;
    renderPinDots();
    pinError.classList.add('hidden');
    if (pinBuffer.length === 6) submitPin();
  });
});

numpadClear.addEventListener('click', () => {
  pinBuffer = pinBuffer.slice(0, -1);
  renderPinDots();
});

numpadConfirm.addEventListener('click', submitPin);

// Keyboard support on PIN screen
document.addEventListener('keydown', e => {
  if (!screens.pin.classList.contains('active')) return;
  if (e.key >= '0' && e.key <= '9') {
    if (pinBuffer.length < 6) { pinBuffer += e.key; renderPinDots(); }
    if (pinBuffer.length === 6) submitPin();
  }
  if (e.key === 'Backspace') { pinBuffer = pinBuffer.slice(0, -1); renderPinDots(); }
  if (e.key === 'Enter') submitPin();
});

pinBack.addEventListener('click', () => showScreen('select'));

// ── Landing screen ────────────────────────────────────────────────────────────

document.getElementById('btn-login-org').addEventListener('click', () => openLoginPath('org'));
document.getElementById('btn-login-op').addEventListener('click',  () => openLoginPath('op'));
document.getElementById('select-back').addEventListener('click',   () => showScreen('landing'));

// ── Create screen ─────────────────────────────────────────────────────────────

let selectedColor = '#3b82f6';
createAvatar.style.background = selectedColor;

swatches.forEach(sw => {
  sw.addEventListener('click', () => {
    swatches.forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    selectedColor = sw.dataset.color;
    createAvatar.style.background = selectedColor;
  });
});

createName.addEventListener('input', () => {
  const val = createName.value.trim();
  createAvatar.textContent = val ? val.charAt(0).toUpperCase() : 'A';
  createName.classList.remove('invalid');
});

function makePinToggle(inputEl, toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    const isText = inputEl.type === 'text';
    inputEl.type = isText ? 'password' : 'text';
  });
}
makePinToggle(createPin, pinToggleCreate);
makePinToggle(createPinConfirm, pinToggleConfirm);

function clearCreateErrors() {
  createError.classList.add('hidden');
  createError.textContent = '';
  [createName, createPin, createPinConfirm].forEach(i => i.classList.remove('invalid'));
}

function showCreateError(msg, ...fields) {
  createError.textContent = msg;
  createError.classList.remove('hidden');
  fields.forEach(f => f.classList.add('invalid'));
}

function setCreating(loading) {
  createSubmit.disabled = loading;
  createBtnLabel.textContent = loading ? 'Creating…' : 'Create Profile';
  createSpinner.classList.toggle('hidden', !loading);
}

createForm.addEventListener('submit', async e => {
  e.preventDefault();
  clearCreateErrors();

  const name = createName.value.trim();
  const pin  = createPin.value.trim();
  const pin2 = createPinConfirm.value.trim();

  if (!name) { showCreateError('Display name is required.', createName); return; }
  if (name.length < 2) { showCreateError('Name must be at least 2 characters.', createName); return; }

  if (!pin) { showCreateError('PIN is required.', createPin); return; }
  if (!/^\d{4,6}$/.test(pin)) { showCreateError('PIN must be 4–6 digits.', createPin); return; }
  if (pin !== pin2) { showCreateError('PINs do not match.', createPin, createPinConfirm); return; }

  setCreating(true);
  try {
    const trader = await createTrader(name, selectedColor, pin);
    setTraderSession(trader);
    window.location.replace('index.html');
  } catch (err) {
    showCreateError(err.message || 'Failed to create operator.');
    setCreating(false);
  }
});

btnGoCreate.addEventListener('click', () => {
  createName.value = '';
  createPin.value = '';
  createPinConfirm.value = '';
  createAvatar.textContent = 'A';
  createAvatar.style.background = '#3b82f6';
  swatches.forEach(s => s.classList.toggle('active', s.dataset.color === '#3b82f6'));
  selectedColor = '#3b82f6';
  clearCreateErrors();
  showScreen('create');
});

createBack.addEventListener('click', () => showScreen('select'));

// ── Setup screen (first-run: create senior administrator) ─────────────────────

const setupForm           = document.getElementById('setup-form');
const setupAvatar         = document.getElementById('setup-avatar');
const setupSwatches       = document.querySelectorAll('.setup-swatch');
const setupOrg            = document.getElementById('setup-org');
const setupName           = document.getElementById('setup-name');
const setupPin            = document.getElementById('setup-pin');
const setupPinConfirm     = document.getElementById('setup-pin-confirm');
const setupError          = document.getElementById('setup-error');
const setupSubmit         = document.getElementById('setup-submit');
const setupBtnLabel       = document.getElementById('setup-btn-label');
const setupSpinner        = document.getElementById('setup-spinner');
const pinToggleSetup      = document.getElementById('pin-toggle-setup');
const pinToggleSetupConfirm = document.getElementById('pin-toggle-setup-confirm');

let setupColor = '#e11d48';
setupAvatar.style.background = setupColor;

setupSwatches.forEach(sw => {
  sw.addEventListener('click', () => {
    setupSwatches.forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    setupColor = sw.dataset.color;
    setupAvatar.style.background = setupColor;
  });
});

setupName.addEventListener('input', () => {
  const val = setupName.value.trim();
  setupAvatar.textContent = val ? val.charAt(0).toUpperCase() : 'A';
  setupName.classList.remove('invalid');
});

makePinToggle(setupPin, pinToggleSetup);
makePinToggle(setupPinConfirm, pinToggleSetupConfirm);

setupForm.addEventListener('submit', async e => {
  e.preventDefault();
  setupError.classList.add('hidden');
  setupError.textContent = '';
  [setupOrg, setupName, setupPin, setupPinConfirm].forEach(i => i.classList.remove('invalid'));

  const org  = setupOrg.value.trim();
  const name = setupName.value.trim();
  const pin  = setupPin.value.trim();
  const pin2 = setupPinConfirm.value.trim();

  if (!org) { setupError.textContent = 'Organisation name is required.'; setupError.classList.remove('hidden'); setupOrg.classList.add('invalid'); return; }
  if (org.length < 2) { setupError.textContent = 'Organisation name must be at least 2 characters.'; setupError.classList.remove('hidden'); setupOrg.classList.add('invalid'); return; }
  if (!name) { setupError.textContent = 'Display name is required.'; setupError.classList.remove('hidden'); setupName.classList.add('invalid'); return; }
  if (name.length < 2) { setupError.textContent = 'Name must be at least 2 characters.'; setupError.classList.remove('hidden'); setupName.classList.add('invalid'); return; }
  if (!pin || !/^\d{4,6}$/.test(pin)) { setupError.textContent = 'PIN must be 4–6 digits.'; setupError.classList.remove('hidden'); setupPin.classList.add('invalid'); return; }
  if (pin !== pin2) { setupError.textContent = 'PINs do not match.'; setupError.classList.remove('hidden'); setupPin.classList.add('invalid'); setupPinConfirm.classList.add('invalid'); return; }

  setupSubmit.disabled = true;
  setupBtnLabel.textContent = 'Creating…';
  setupSpinner.classList.remove('hidden');
  try {
    const trader = await createTrader(name, setupColor, pin, 'owner', org);
    setTraderSession(trader);
    window.location.replace('index.html');
  } catch (err) {
    setupError.textContent = err.message || 'Failed to create administrator.';
    setupError.classList.remove('hidden');
    setupSubmit.disabled = false;
    setupBtnLabel.textContent = 'Get Started';
    setupSpinner.classList.add('hidden');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

// If operator is already logged in, skip login page
if (getValidTraderSession()) {
  window.location.replace('index.html');
} else {
  loadOperators();
}
