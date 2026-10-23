/** Small DOM helpers shared by the admin pages */

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Clones a <template> by id; `field(name)` finds its `data-field` elements */
export function cloneTemplate(id: string) {
  const frag = $<HTMLTemplateElement>(id).content.cloneNode(true) as DocumentFragment;
  const field = <T extends HTMLElement = HTMLElement>(name: string) =>
    frag.querySelector(`[data-field="${name}"]`) as T;
  return { frag, field };
}

/** Shows a busy spinner and disables the button while `fn` runs */
export async function withBusy(btn: HTMLButtonElement, fn: () => Promise<void>) {
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

/** Copies text and briefly shows the check mark on a CopyButton */
export async function copyWithFeedback(btn: HTMLElement, text: string) {
  await navigator.clipboard.writeText(text);
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1500);
}

export function setMuted(el: HTMLElement, text: string) {
  el.textContent = text;
  el.classList.add('muted');
}
