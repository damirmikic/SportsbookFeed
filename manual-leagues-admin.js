import { state, isManualLeague } from './state.js';
import {
  fetchManualLeagues,
  createManualLeague,
  updateManualLeague,
  deleteManualLeague,
  fetchManualEvents,
  createManualEvent,
  updateManualEvent,
  deleteManualEvent,
} from './api.js';
import { dcMatchProbs, dcOverProb } from './math.js';
import { loadOdds } from './ui-board.js';
import { renderLeagues } from './ui-leagues.js';

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ─────────────────────────────────────────────────
let _leagues = [];
let _activeLeagueCode = null;
let _events = [];
let _editingEventId = null;
let _editingLeagueId = null;

// ── Helpers ───────────────────────────────────────────────

function computePreview(formEl) {
  const mode = formEl.querySelector('input[name="input_mode"]:checked')?.value;
  const preview = formEl.querySelector('.ml-odds-preview');
  if (!preview) return;

  if (mode === 'lambdas') {
    const lh  = parseFloat(formEl.querySelector('[name="lh"]')?.value);
    const la  = parseFloat(formEl.querySelector('[name="la"]')?.value);
    const rho = parseFloat(formEl.querySelector('[name="rho"]')?.value || '0');
    const line = parseFloat(formEl.querySelector('[name="ou_line"]')?.value || '2.5');
    if (!isNaN(lh) && !isNaN(la) && lh > 0 && la > 0) {
      const { pH, pD, pA } = dcMatchProbs(lh, la, rho);
      const pOver = dcOverProb(lh, la, rho, line);
      const fmt = v => (1 / v).toFixed(3);
      preview.textContent =
        `1x2: ${fmt(pH)} / ${fmt(pD)} / ${fmt(pA)} · O${line}: ${(1/pOver).toFixed(3)} / U${line}: ${(1/(1-pOver)).toFixed(3)}`;
    } else {
      preview.textContent = '';
    }
  } else {
    preview.textContent = '';
  }
}

function toggleModeFields(formEl, mode) {
  formEl.querySelector('.ml-odds-fields').classList.toggle('hidden', mode !== 'odds');
  formEl.querySelector('.ml-lambda-fields').classList.toggle('hidden', mode !== 'lambdas');
}

function eventFormHtml(ev = null) {
  const isEdit = !!ev;
  const mode = ev?.input_mode || 'odds';

  const dateStr = ev?.starts
    ? new Date(ev.starts).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const timeStr = ev?.starts
    ? new Date(ev.starts).toTimeString().slice(0, 5)
    : '15:00';

  return `
    <form class="ml-event-form" data-edit-id="${isEdit ? escapeHtml(ev.id) : ''}">
      <div class="ml-form-row">
        <label>Home team
          <input name="home" type="text" placeholder="e.g. Barcelona" value="${escapeHtml(ev?.home ?? '')}" required autocomplete="off">
        </label>
        <label>Away team
          <input name="away" type="text" placeholder="e.g. Real Madrid" value="${escapeHtml(ev?.away ?? '')}" required autocomplete="off">
        </label>
      </div>
      <div class="ml-form-row">
        <label>Date
          <input name="date" type="date" value="${escapeHtml(dateStr)}" required>
        </label>
        <label>Kick-off time
          <input name="time" type="time" value="${escapeHtml(timeStr)}" required>
        </label>
      </div>

      <div class="ml-mode-toggle">
        <span class="ml-mode-label">Odds source:</span>
        <label class="ml-radio-label">
          <input type="radio" name="input_mode" value="odds" ${mode === 'odds' ? 'checked' : ''}>
          Enter odds
        </label>
        <label class="ml-radio-label">
          <input type="radio" name="input_mode" value="lambdas" ${mode === 'lambdas' ? 'checked' : ''}>
          Enter lambdas (Dixon-Coles)
        </label>
        <label class="ml-goals-line-wrap">
          Goals line
          <input name="ou_line" type="number" step="0.5" min="0.5" max="9.5" placeholder="2.5"
            value="${escapeHtml(ev?.ou_line ?? '2.5')}">
        </label>
      </div>

      <div class="ml-odds-fields ${mode !== 'odds' ? 'hidden' : ''}">
        <div class="ml-form-row">
          <label>1 (Home)
            <input name="home_odds" type="number" step="0.001" min="1.001" placeholder="e.g. 1.85"
              value="${escapeHtml(ev?.home_odds ?? '')}">
          </label>
          <label>X (Draw)
            <input name="draw_odds" type="number" step="0.001" min="1.001" placeholder="e.g. 3.50"
              value="${escapeHtml(ev?.draw_odds ?? '')}">
          </label>
          <label>2 (Away)
            <input name="away_odds" type="number" step="0.001" min="1.001" placeholder="e.g. 4.20"
              value="${escapeHtml(ev?.away_odds ?? '')}">
          </label>
        </div>
        <div class="ml-form-row">
          <label class="ml-over-label">Over
            <input name="over_odds" type="number" step="0.001" min="1.001" placeholder="e.g. 1.90"
              value="${escapeHtml(ev?.over_odds ?? '')}">
          </label>
          <label class="ml-under-label">Under
            <input name="under_odds" type="number" step="0.001" min="1.001" placeholder="e.g. 1.95"
              value="${escapeHtml(ev?.under_odds ?? '')}">
          </label>
        </div>
      </div>

      <div class="ml-lambda-fields ${mode !== 'lambdas' ? 'hidden' : ''}">
        <div class="ml-form-row">
          <label>λ Home
            <input name="lh" type="number" step="0.01" min="0.1" max="6" placeholder="e.g. 1.60"
              value="${escapeHtml(ev?.lh ?? '')}">
          </label>
          <label>λ Away
            <input name="la" type="number" step="0.01" min="0.1" max="6" placeholder="e.g. 1.10"
              value="${escapeHtml(ev?.la ?? '')}">
          </label>
          <label>ρ (correlation)
            <input name="rho" type="number" step="0.01" min="-0.25" max="0.1" placeholder="0"
              value="${escapeHtml(ev?.rho ?? '0')}">
          </label>
        </div>
        <div class="ml-odds-preview"></div>
      </div>

      <div class="ml-form-actions">
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Add event'}</button>
        <button type="button" class="btn-ghost ml-cancel-btn">Cancel</button>
      </div>
    </form>
  `;
}

function collectEventFormData(formEl) {
  const mode = formEl.querySelector('input[name="input_mode"]:checked')?.value || 'odds';
  const date = formEl.querySelector('[name="date"]').value;
  const time = formEl.querySelector('[name="time"]').value;
  const starts = new Date(`${date}T${time}:00`).toISOString();

  const val = name => {
    const v = formEl.querySelector(`[name="${name}"]`)?.value?.trim();
    return v !== '' && v !== undefined ? Number(v) : null;
  };

  return {
    home:       formEl.querySelector('[name="home"]').value.trim(),
    away:       formEl.querySelector('[name="away"]').value.trim(),
    starts,
    input_mode: mode,
    lh:         mode === 'lambdas' ? val('lh')          : null,
    la:         mode === 'lambdas' ? val('la')          : null,
    rho:        mode === 'lambdas' ? val('rho')         : null,
    home_odds:  mode === 'odds'    ? val('home_odds')   : null,
    draw_odds:  mode === 'odds'    ? val('draw_odds')   : null,
    away_odds:  mode === 'odds'    ? val('away_odds')   : null,
    over_odds:  mode === 'odds'    ? val('over_odds')   : null,
    under_odds: mode === 'odds'    ? val('under_odds')  : null,
    ou_line:    val('ou_line') ?? 2.5,
  };
}

// ── Rendering ─────────────────────────────────────────────

function renderEventsTable(container) {
  const tbody = container.querySelector('.ml-events-tbody');
  if (!tbody) return;

  if (!_events.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="ml-empty-cell">No events yet. Add one below.</td></tr>`;
    return;
  }

  tbody.innerHTML = _events.map(ev => {
    const dt = ev.starts ? new Date(ev.starts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '–';
    const modeLabel = ev.input_mode === 'lambdas'
      ? `λ ${parseFloat(ev.lh).toFixed(2)} / ${parseFloat(ev.la).toFixed(2)}`
      : 'Odds';
    return `
      <tr data-event-id="${escapeHtml(ev.id)}">
        <td>${escapeHtml(ev.home)} – ${escapeHtml(ev.away)}</td>
        <td>${dt}</td>
        <td><span class="ml-mode-chip">${modeLabel}</span></td>
        <td class="ml-actions">
          <button class="btn-ghost btn-sm ml-edit-event-btn" data-id="${escapeHtml(ev.id)}">Edit</button>
          <button class="btn-ghost btn-sm btn-danger ml-delete-event-btn" data-id="${escapeHtml(ev.id)}">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderLeagueSection(container, league) {
  _activeLeagueCode = league.code;

  const existing = container.querySelector('.ml-events-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.className = 'ml-events-section';
  section.innerHTML = `
    <div class="ml-events-header">
      <h4>Events — <em>${escapeHtml(league.name)}</em></h4>
      <button class="btn-ghost btn-sm ml-close-events-btn">✕ Close</button>
    </div>
    <table class="ml-events-table">
      <thead>
        <tr>
          <th>Match</th><th>Kick-off</th><th>Source</th><th>Actions</th>
        </tr>
      </thead>
      <tbody class="ml-events-tbody"></tbody>
    </table>
    <div class="ml-add-event-wrap">
      <button class="btn-secondary ml-show-add-form-btn">+ Add Event</button>
      <div class="ml-add-form-slot"></div>
    </div>
  `;

  container.appendChild(section);
  renderEventsTable(section);
  wireEventsSection(section, league);
}

function wireEventsSection(section, league) {
  section.querySelector('.ml-close-events-btn').addEventListener('click', () => {
    section.remove();
    _activeLeagueCode = null;
    _editingEventId = null;
  });

  section.querySelector('.ml-show-add-form-btn').addEventListener('click', () => {
    const slot = section.querySelector('.ml-add-form-slot');
    if (slot.querySelector('.ml-event-form')) return;
    slot.innerHTML = eventFormHtml(null);
    wireEventForm(slot.querySelector('.ml-event-form'), league.code, section);
  });

  section.addEventListener('click', async e => {
    const editBtn = e.target.closest('.ml-edit-event-btn');
    if (editBtn) {
      const id = editBtn.dataset.id;
      const ev = _events.find(x => x.id === id);
      if (!ev) return;
      _editingEventId = id;
      const row = section.querySelector(`tr[data-event-id="${id}"]`);
      const existingForm = row?.nextElementSibling?.querySelector('.ml-event-form');
      if (existingForm) { existingForm.closest('tr')?.remove(); _editingEventId = null; return; }
      const formTr = document.createElement('tr');
      formTr.innerHTML = `<td colspan="4" class="ml-edit-form-cell">${eventFormHtml(ev)}</td>`;
      row?.insertAdjacentElement('afterend', formTr);
      wireEventForm(formTr.querySelector('.ml-event-form'), league.code, section, ev);
      return;
    }

    const delBtn = e.target.closest('.ml-delete-event-btn');
    if (delBtn) {
      const id = delBtn.dataset.id;
      const ev = _events.find(x => x.id === id);
      if (!ev) return;
      if (!confirm(`Delete event "${ev.home} – ${ev.away}"?`)) return;
      try {
        await deleteManualEvent(id);
        _events = _events.filter(x => x.id !== id);
        renderEventsTable(section);
        if (isManualLeague(league.code) && state.currentLeagueCode === league.code) {
          await loadOdds(league.code, true);
        }
      } catch (err) {
        alert('Failed to delete event: ' + err.message);
      }
    }
  });
}

function wireEventForm(formEl, leagueCode, section, existing = null) {
  const modeInputs = formEl.querySelectorAll('input[name="input_mode"]');
  modeInputs.forEach(r => r.addEventListener('change', () => {
    toggleModeFields(formEl, r.value);
    computePreview(formEl);
  }));

  const lambdaInputs = formEl.querySelectorAll('.ml-lambda-fields input');
  lambdaInputs.forEach(i => i.addEventListener('input', () => computePreview(formEl)));

  const ouLineInput = formEl.querySelector('[name="ou_line"]');
  if (ouLineInput) {
    const updateOuLabels = () => {
      const line = ouLineInput.value || '2.5';
      const overLabel = formEl.querySelector('.ml-over-label');
      const underLabel = formEl.querySelector('.ml-under-label');
      if (overLabel) overLabel.childNodes[0].textContent = `Over ${line}`;
      if (underLabel) underLabel.childNodes[0].textContent = `Under ${line}`;
      computePreview(formEl);
    };
    ouLineInput.addEventListener('input', updateOuLabels);
    updateOuLabels();
  }

  formEl.querySelector('.ml-cancel-btn').addEventListener('click', () => {
    formEl.closest('tr')?.remove() || formEl.closest('.ml-add-form-slot')?.replaceChildren();
    _editingEventId = null;
  });

  formEl.addEventListener('submit', async e => {
    e.preventDefault();
    const data = collectEventFormData(formEl);
    if (!data.home || !data.away) return;
    data.league_code = leagueCode;

    try {
      if (existing) {
        await updateManualEvent(existing.id, data);
        _events = _events.map(x => x.id === existing.id ? { ...x, ...data } : x);
        formEl.closest('tr')?.remove();
        _editingEventId = null;
      } else {
        const created = await createManualEvent(data);
        _events = [..._events, created];
        formEl.closest('.ml-add-form-slot')?.replaceChildren();
      }
      renderEventsTable(section);
      if (isManualLeague(leagueCode) && state.currentLeagueCode === leagueCode) {
        await loadOdds(leagueCode, true);
      }
    } catch (err) {
      alert('Failed to save event: ' + err.message);
    }
  });

  computePreview(formEl);
}

// ── Main panel renderer ───────────────────────────────────

export async function renderManualLeaguesPanel() {
  const panel = document.getElementById('manual-leagues-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="admin-section ml-panel">
      <div class="ml-panel-header">
        <h3>Custom Leagues</h3>
        <button class="btn-primary ml-new-league-btn">+ New League</button>
      </div>
      <div class="ml-new-league-form-slot"></div>
      <div class="ml-leagues-list"></div>
    </div>
  `;

  const listEl = panel.querySelector('.ml-leagues-list');
  const newFormSlot = panel.querySelector('.ml-new-league-form-slot');

  // Load leagues
  try {
    _leagues = await fetchManualLeagues();
    state.manualLeagues.splice(0, state.manualLeagues.length, ..._leagues);
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load custom leagues: ${escapeHtml(err.message)}</div>`;
    return;
  }

  renderLeaguesList(listEl, panel);

  // New league button
  panel.querySelector('.ml-new-league-btn').addEventListener('click', () => {
    if (newFormSlot.querySelector('.ml-new-league-form')) return;
    newFormSlot.innerHTML = `
      <form class="ml-new-league-form">
        <label>League name (use "Country - League" format for grouping)
          <input name="name" type="text" placeholder="e.g. Custom - My League" required autocomplete="off" style="width:100%">
        </label>
        <div class="ml-form-actions">
          <button type="submit" class="btn-primary">Create league</button>
          <button type="button" class="btn-ghost ml-cancel-new-btn">Cancel</button>
        </div>
      </form>
    `;
    newFormSlot.querySelector('.ml-cancel-new-btn').addEventListener('click', () => newFormSlot.replaceChildren());
    newFormSlot.querySelector('.ml-new-league-form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = e.target.querySelector('[name="name"]').value.trim();
      if (!name) return;
      try {
        const created = await createManualLeague(name, state.currentTraderId);
        _leagues = [created, ..._leagues];
        state.manualLeagues.splice(0, state.manualLeagues.length, ..._leagues);
        // Update allLeagues so sidebar shows the new league immediately
        const already = state.allLeagues.find(l => l.code === created.code);
        if (!already) state.allLeagues.push({ ...created, isManual: true });
        renderLeagues(state.allLeagues);
        newFormSlot.replaceChildren();
        renderLeaguesList(listEl, panel);
      } catch (err) {
        alert('Failed to create league: ' + err.message);
      }
    });
  });
}

function renderLeaguesList(listEl, panel) {
  if (!_leagues.length) {
    listEl.innerHTML = `<div class="empty-state">No custom leagues yet. Create one above.</div>`;
    return;
  }

  listEl.innerHTML = _leagues.map(l => `
    <div class="ml-league-row" data-league-id="${escapeHtml(l.id)}" data-league-code="${escapeHtml(l.code)}">
      <div class="ml-league-info">
        <span class="ml-league-name">${escapeHtml(l.name)}</span>
        <span class="ml-league-code">${escapeHtml(l.code)}</span>
      </div>
      <div class="ml-league-actions">
        <button class="btn-ghost btn-sm ml-manage-events-btn" data-code="${escapeHtml(l.code)}">Manage Events</button>
        <button class="btn-ghost btn-sm ml-rename-league-btn" data-id="${escapeHtml(l.id)}">Rename</button>
        <button class="btn-ghost btn-sm btn-danger ml-delete-league-btn" data-id="${escapeHtml(l.id)}" data-code="${escapeHtml(l.code)}">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.addEventListener('click', async e => {
    const manageBtn = e.target.closest('.ml-manage-events-btn');
    if (manageBtn) {
      const code = manageBtn.dataset.code;
      const league = _leagues.find(l => l.code === code);
      if (!league) return;
      try {
        _events = await fetchManualEvents(code);
      } catch (err) {
        alert('Failed to load events: ' + err.message);
        return;
      }
      renderLeagueSection(panel.querySelector('.admin-section'), league);
      return;
    }

    const renameBtn = e.target.closest('.ml-rename-league-btn');
    if (renameBtn) {
      const id = renameBtn.dataset.id;
      const league = _leagues.find(l => l.id === id);
      if (!league) return;
      const newName = prompt('Rename league:', league.name);
      if (!newName || newName.trim() === league.name) return;
      try {
        await updateManualLeague(id, newName.trim());
        _leagues = _leagues.map(l => l.id === id ? { ...l, name: newName.trim() } : l);
        state.manualLeagues.splice(0, state.manualLeagues.length, ..._leagues);
        const inAll = state.allLeagues.find(l => l.code === league.code);
        if (inAll) inAll.name = newName.trim();
        renderLeagues(state.allLeagues);
        renderLeaguesList(listEl, panel);
      } catch (err) {
        alert('Failed to rename: ' + err.message);
      }
      return;
    }

    const deleteBtn = e.target.closest('.ml-delete-league-btn');
    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      const code = deleteBtn.dataset.code;
      const league = _leagues.find(l => l.id === id);
      if (!confirm(`Delete league "${league?.name}" and all its events? This cannot be undone.`)) return;
      try {
        await deleteManualLeague(id);
        _leagues = _leagues.filter(l => l.id !== id);
        state.manualLeagues.splice(0, state.manualLeagues.length, ..._leagues);
        state.allLeagues = state.allLeagues.filter(l => l.code !== code);
        renderLeagues(state.allLeagues);
        renderLeaguesList(listEl, panel);
        panel.querySelector('.ml-events-section')?.remove();
      } catch (err) {
        alert('Failed to delete league: ' + err.message);
      }
    }
  });
}
