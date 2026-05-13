const DEFAULT_SESSION_TTL_MODE = 'duration'; // 'duration' or 'end-of-day'
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const SESSION_KEYS = [
  'currentTraderId',
  'currentTraderName',
  'currentTraderColor',
  'currentTraderRole',
  'currentTraderLoggedInAt',
  'currentTraderProfile',
];

function readSessionTtlMode() {
  const mode = localStorage.getItem('sessionTtlMode') || DEFAULT_SESSION_TTL_MODE;
  return mode === 'end-of-day' ? mode : 'duration';
}

function readSessionTtlMs() {
  const ttl = Number(localStorage.getItem('sessionTtlMs'));
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS;
}

function endOfDayAfter(timestamp) {
  const expiresAt = new Date(timestamp);
  expiresAt.setHours(24, 0, 0, 0);
  return expiresAt.getTime();
}

export function clearTraderSession() {
  SESSION_KEYS.forEach(key => localStorage.removeItem(key));
}

export function setTraderSession(trader, loggedInAt = new Date().toISOString()) {
  const profile = {
    id: trader.id,
    name: trader.name,
    color: trader.color || '#3b82f6',
    role: trader.role || 'trader',
    loggedInAt,
  };

  localStorage.setItem('currentTraderId', profile.id);
  localStorage.setItem('currentTraderName', profile.name);
  localStorage.setItem('currentTraderColor', profile.color);
  localStorage.setItem('currentTraderRole', profile.role);
  localStorage.setItem('currentTraderLoggedInAt', profile.loggedInAt);
  localStorage.setItem('currentTraderProfile', JSON.stringify(profile));

  return profile;
}

export function getTraderSession() {
  const id = localStorage.getItem('currentTraderId');
  if (!id) return null;

  return {
    id,
    name:      localStorage.getItem('currentTraderName')  || '?',
    color:     localStorage.getItem('currentTraderColor') || '#3b82f6',
    role:      localStorage.getItem('currentTraderRole')  || 'trader',
    loggedInAt: localStorage.getItem('currentTraderLoggedInAt'),
  };
}

export function getSessionExpiresAt(session = getTraderSession()) {
  if (!session?.loggedInAt) return 0;

  const loggedInAt = Date.parse(session.loggedInAt);
  if (Number.isNaN(loggedInAt)) return 0;

  if (readSessionTtlMode() === 'end-of-day') {
    return endOfDayAfter(loggedInAt);
  }
  return loggedInAt + readSessionTtlMs();
}

export function isTraderSessionExpired(session = getTraderSession()) {
  if (!session) return true;
  return getSessionExpiresAt(session) <= Date.now();
}

export function getValidTraderSession() {
  const session = getTraderSession();
  if (!session) return null;
  if (isTraderSessionExpired(session)) {
    clearTraderSession();
    return null;
  }
  return session;
}
