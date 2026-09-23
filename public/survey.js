// Enhancements for the open-answer form. The form works without JavaScript too.
(() => {
  // After a successful submission, forget any saved drafts on this device.
  if (document.querySelector('[data-survey-done]')) {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('survey-draft-')).forEach((k) => localStorage.removeItem(k));
    } catch {}
    return;
  }

  const form = document.querySelector('.answer-form');
  if (!form) return;
  const textarea = form.querySelector('textarea');
  const counter = form.querySelector('.counter');
  const button = form.querySelector('button[type=submit]');
  const max = Number(counter.dataset.max);
  const key = form.dataset.draftKey;

  // The draft lives only in this browser (never sent until submitted).
  const storage = {
    get: () => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (v) => { try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch {} },
  };

  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  };

  const update = () => {
    const text = textarea.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    counter.textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${text.length}/${max}`;
    counter.classList.toggle('warn', text.length > max * 0.9);
    button.disabled = !text.trim();
    grow();
  };

  if (!textarea.value) textarea.value = storage.get() || '';
  let timer;
  textarea.addEventListener('input', () => {
    update();
    clearTimeout(timer);
    timer = setTimeout(() => storage.set(textarea.value), 300);
  });

  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    form.querySelectorAll('kbd').forEach((k) => { if (k.textContent === 'Ctrl') k.textContent = '⌘'; });
  }
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && textarea.value.trim()) form.requestSubmit();
  });

  form.addEventListener('submit', () => {
    clearTimeout(timer);
    storage.set(textarea.value);
    button.disabled = true;
    button.firstChild.textContent = 'Sending… ';
  });

  // Put the cursor at the end of a restored draft.
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  update();
})();
