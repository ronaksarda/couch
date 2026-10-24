import type { CardItem, CouchApi } from '../electron/preload';

const api = (window as unknown as { couch: CouchApi }).couch;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const cards = $<HTMLOListElement>('cards');
const sheet = $<HTMLDialogElement>('confirm');
const undo = $<HTMLButtonElement>('undo');
let confirmId: string | null = null;

function answer(yes: boolean) {
  if (!confirmId) return; // already answered: only the first tap counts
  api.send({ c: 'confirm', id: confirmId, yes });
  confirmId = null;
  sheet.close();
}

$('yes').addEventListener('click', () => answer(true));
$('no').addEventListener('click', () => answer(false));
sheet.addEventListener('cancel', () => answer(false)); // Escape means No
// Small popup by default; click the summary to open the full cards (with thumbnails), click again to shrink.
const toggle = $<HTMLButtonElement>('toggle');
function expand(on: boolean) {
  document.body.classList.toggle('compact', !on);
  toggle.setAttribute('aria-expanded', String(on));
  api.send({ c: 'expand', on });
}
toggle.addEventListener('click', () => expand(document.body.classList.contains('compact')));
$('close').addEventListener('click', () => api.send({ c: 'closeResults' }));
const summary = (text: string) => (toggle.textContent = text);

undo.addEventListener('click', () => {
  api.send({ c: 'undo' });
});

function button(label: string, onClick: () => void, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

/** The header already shows the title. Body: paragraphs, and "- " / "1. " lines as real lists. Text only, never innerHTML. */
function textCard(_title: string, body: string) {
  const li = document.createElement('li');
  li.className = 'answer';
  let list: HTMLUListElement | HTMLOListElement | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const m = /^(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (m) {
      if (!list || (m[1] ? list.tagName !== 'OL' : list.tagName !== 'UL')) li.append((list = document.createElement(m[1] ? 'ol' : 'ul')));
      const item = document.createElement('li');
      item.textContent = m[2];
      list.append(item);
    } else {
      list = null;
      const p = document.createElement('p');
      p.textContent = line;
      li.append(p);
    }
  }
  return li;
}

/** A result set. While picking, each card has a Pick button and the set ends with "None of these". */
function resultSet(items: CardItem[], picking: boolean) {
  const li = document.createElement('li');
  li.className = picking ? 'set' : 'set done';
  const ol = document.createElement('ol');
  const pick = (i: number) => {
    if (li.classList.contains('done')) return;
    li.classList.add('done');
    api.send({ c: 'pick', index: i });
    // Only the choice stays: the other options go away.
    const note = document.createElement('p');
    note.className = 'picked';
    note.textContent = i < 0 ? 'None of these. Fine, forget it.' : 'You picked this one.';
    const keep = i < 0 ? [] : [ol.children[i]];
    ol.replaceChildren(...keep);
    li.querySelector(':scope > button')?.remove();
    li.prepend(note);
    summary(i < 0 ? 'Nothing picked' : `Picked: ${items[i].title}`);
  };
  items.forEach((it, i) => {
    const row = document.createElement('li');
    const h = document.createElement('h2');
    // Real type up front: "pdf", "video", "song", "link". Files show their extension.
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = it.kind === 'file' ? (/\.([a-z0-9]{1,5})$/i.exec(it.title)?.[1] ?? 'file') : it.kind;
    h.append(kind, `${i + 1}. ${it.title}`);
    const d = document.createElement('p');
    d.className = 'muted';
    d.textContent = it.detail;
    if (it.thumb?.startsWith('https://i.ytimg.com/')) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = it.thumb;
      img.alt = '';
      img.loading = 'lazy';
      row.append(img);
    }
    row.append(h, d);
    if (it.snippet) {
      const s = document.createElement('p');
      s.className = 'snippet';
      s.textContent = it.snippet;
      row.append(s);
    }
    const bar = document.createElement('div');
    bar.className = 'bar';
    if (picking) bar.append(button('Pick', () => pick(i), 'yes'));
    if (it.kind === 'file')
      bar.append(
        button('Open', () => api.send({ c: 'cardAction', key: it.key, action: 'open' })),
        button('Show in folder', () => api.send({ c: 'cardAction', key: it.key, action: 'reveal' })),
        button('Copy path', () => api.send({ c: 'cardAction', key: it.key, action: 'copyPath' })),
      );
    if (bar.childElementCount) row.append(bar);
    ol.append(row);
  });
  li.append(ol);
  if (picking) li.append(button('None of these', () => pick(-1)));
  return li;
}

/** Each new answer replaces the old ones: the popup shows what you just asked about, nothing older. */
function add(li: HTMLLIElement) {
  cards.replaceChildren(li);
  $('empty').hidden = true;
}

api.on((ev) => {
  if (ev.t === 'card') {
    add(textCard(ev.title, ev.body));
    summary(ev.title);
    expand(true); // an answer to read opens itself
  }
  else if (ev.t === 'cards') {
    add(resultSet(ev.items, ev.picking));
    summary(ev.items.length ? `${ev.picking ? 'Pick one: ' : ''}${ev.items.length} result${ev.items.length === 1 ? '' : 's'} · tap to see` : 'Nothing found');
    if (ev.items.length) expand(true); // results open themselves: a collapsed "tap to see" looked like he gave up
    if (ev.picking) cards.querySelector<HTMLButtonElement>('.set .yes')?.focus();
  } else if (ev.t === 'undo') undo.hidden = !ev.on;
  else if (ev.t === 'closeConfirm') {
    confirmId = null;
    if (sheet.open) sheet.close();
  } else if (ev.t === 'confirm') {
    confirmId = ev.id;
    $('cAction').textContent = ev.action;
    $('cSource').textContent = ev.source;
    $('cDest').textContent = ev.dest;
    $('cSize').textContent = ev.size;
    const img = $<HTMLImageElement>('cImage');
    img.hidden = !ev.image?.startsWith('data:image/');
    img.src = img.hidden ? '' : ev.image!;
    expand(true);
    if (!sheet.open) sheet.showModal();
    $('no').focus(); // a stray Enter must never approve: Yes is a deliberate click
  }
});
