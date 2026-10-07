// Shared UI helpers. DOM access only inside functions so this imports cleanly in Node.

export const VERSION = '0.1.1';

const MINUS = '−';

export function fmt1(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  const s = v.toFixed(1);
  // A value that rounds to zero is shown without a sign.
  if (Number(s) === 0) return '0.0';
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

export function fmtSigned(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  const s = fmt1(v);
  return v > 0 && Number(v.toFixed(1)) !== 0 ? `+${s}` : s;
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function segmented(container, items, selected, onPick, { mono = false } = {}) {
  container.classList.add('seg');
  if (mono) container.classList.add('mono');
  container.textContent = '';
  const buttons = new Map();
  for (const { value, label } of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(value === selected));
    b.addEventListener('click', () => onPick(value));
    container.appendChild(b);
    buttons.set(value, b);
  }
  return {
    set(value) {
      for (const [v, b] of buttons) b.setAttribute('aria-pressed', String(v === value));
    },
  };
}
