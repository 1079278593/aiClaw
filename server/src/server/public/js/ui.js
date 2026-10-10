let iconFrame = 0;
let lastModalTrigger = null;

export function refreshIcons() {
  if (!window.lucide) return;
  window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

export function initIcons() {
  refreshIcons();
  const observer = new MutationObserver((mutations) => {
    const hasIcons = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          (node.matches?.("[data-lucide]") || node.querySelector?.("[data-lucide]")),
      ),
    );
    if (!hasIcons || iconFrame) return;
    iconFrame = requestAnimationFrame(() => {
      iconFrame = 0;
      refreshIcons();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function markModalOpen(modal) {
  lastModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  requestAnimationFrame(() => {
    const target = modal?.querySelector(
      "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    target?.focus();
  });
}

export function markModalClosed() {
  lastModalTrigger?.focus();
  lastModalTrigger = null;
}

export function trapModalFocus(event, modal) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    modal.querySelectorAll(
      "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ),
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
