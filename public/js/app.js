const cards = document.querySelectorAll('.mode-card');
const stage = document.getElementById('stage');

function note(text, link) {
  let p = document.getElementById('modeNote');
  if (!p) {
    p = document.createElement('p');
    p.id = 'modeNote';
    p.style.cssText = 'margin-top:22px;color:var(--orange);font-size:.9rem;text-align:center';
    stage.appendChild(p);
  }
  p.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link; a.textContent = ' Open the calendar';
    a.style.color = 'var(--green)';
    p.appendChild(a);
  }
}

cards.forEach(card => {
  card.addEventListener('click', async () => {
    const mode = card.dataset.mode;          // "local" or "global"
    try {
      const res = await fetch('/api/geo/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      if (res.status === 409) {
        const d = await res.json();
        return note(d.error, 'fire.html');
      }
      if (!res.ok) throw new Error('bad response');
    } catch {
      return note('Cannot reach the server. Is it running?');
    }

    sessionStorage.setItem('es_mode', mode);
    stage.classList.add('leaving');          // fade out animation
    setTimeout(() => { window.location.href = 'login.html'; }, 500);
  });
});