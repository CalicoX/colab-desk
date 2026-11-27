// Lightweight pub/sub & action registry to guarantee a strict acyclic module DAG.
const listeners = new Map();
const actions = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of Array.from(set)) fn(payload);
}

export function registerAction(name, handler) {
  actions.set(name, handler);
}

export function callRegistered(name, ...args) {
  const fn = actions.get(name);
  if (typeof fn === "function") return fn(...args);
  return undefined;
}
