import { fetchOddsHistory } from './api.js';

function ensureModal() {
  let backdrop = document.getElementById('odds-history-backdrop');
  if (backdrop) return backdrop;

  backdrop = document.createElement('div');
  backdrop.id = 'odds-history-backdrop';
  backdrop.className = 'odds-history-backdrop';
  backdrop.innerHTML = `
    <div class="odds-history-modal" role="dialog" aria-modal="true" aria-labelledby="odds-history-title">
      <div class="odds-history-header">
        <div>
          <h3 id="odds-history-title">Odds History</h3>
          <p id="odds-history-subtitle"></p>
        </div>
        <button type="button" id="odds-history-close" class="odds-history-close" aria-label="Close odds history">&times;</button>
      </div>
      <div id="odds-history-body" class="odds-history-body"></div>
    </div>`;
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOddsHistory();
  });
  backdrop.querySelector('#odds-history-close').addEventListener('click', closeOddsHistory);
  return backdrop;
}

function closeOddsHistory() {
  document.getElementById('odds-history-backdrop')?.classList.remove('visible');
}

function formatPrice(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 1 ? n.toFixed(2) : '-';
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
}

function entryValue(entry, side) {
  if (!entry?.prices || !side) return null;
  return entry.prices[side] ?? null;
}

function matchesRequest(entry, request) {
  if (request.period != null && String(entry.period) !== String(request.period)) return false;
  if (entry.market !== request.market) return false;
  if (request.points != null && String(entry.prices?.points) !== String(request.points)) return false;
  return entryValue(entry, request.side) != null;
}

function renderSparkline(points) {
  const values = points.map(p => parseFloat(p.value)).filter(Number.isFinite);
  if (values.length < 2) return '<div class="odds-history-empty-chart">Not enough data for chart</div>';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 100 - ((value - min) / span) * 100;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  return `
    <svg class="odds-history-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords}" />
    </svg>`;
}

function renderHistory(entries, request) {
  const rows = entries
    .filter(entry => matchesRequest(entry, request))
    .map(entry => ({ ...entry, value: entryValue(entry, request.side) }));

  if (!rows.length) {
    return '<div class="odds-history-empty">No stored history for this offer yet.</div>';
  }

  const first = parseFloat(rows[0].value);
  const last = parseFloat(rows[rows.length - 1].value);
  const change = Number.isFinite(first) && Number.isFinite(last) ? last - first : null;
  const changeText = change == null ? '-' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}`;

  return `
    <div class="odds-history-summary">
      <span>${rows.length} snapshots</span>
      <span>First ${formatPrice(rows[0].value)}</span>
      <span>Last ${formatPrice(rows[rows.length - 1].value)}</span>
      <span>Move ${changeText}</span>
    </div>
    ${renderSparkline(rows)}
    <div class="odds-history-table-wrap">
      <table class="odds-history-table">
        <thead><tr><th>Time</th><th>Price</th></tr></thead>
        <tbody>
          ${rows.slice().reverse().map(row => `
            <tr>
              <td>${formatTime(row.ts)}</td>
              <td>${formatPrice(row.value)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

export async function openOddsHistory(request) {
  const backdrop = ensureModal();
  const title = backdrop.querySelector('#odds-history-title');
  const subtitle = backdrop.querySelector('#odds-history-subtitle');
  const body = backdrop.querySelector('#odds-history-body');

  title.textContent = request.title || 'Odds History';
  subtitle.textContent = request.subtitle || '';
  body.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading history...</p></div>';
  backdrop.classList.add('visible');

  try {
    const entries = await fetchOddsHistory(request.eventId);
    body.innerHTML = renderHistory(entries, request);
  } catch (error) {
    body.innerHTML = `<div class="odds-history-empty">Failed to load odds history: ${error.message}</div>`;
  }
}
