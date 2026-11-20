import { escapeHtml as html } from './ui.js';

const blockSize = 24;
const grades = { smooth: 'Smooth', moderate: 'Moderate', rough: 'Abrupt', limited: 'Limited data' };

function breakdown(row) {
  const percent = (value) => value === null ? 'Unavailable' : Math.round(value * 100) + '%';
  const fields = [
    ['Pair fit', percent(row.transitionScore)], ['Key compatibility', percent(row.harmonicScore)],
    ['Genre overlap', percent(row.genreScore)], ['Artist adjustment', Math.round(row.artistSpacingBonus * 100) + ' points'],
    ['Comparable weight', percent(row.coverage)],
  ];
  return '<dl>' + fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('') + '</dl>';
}

function transitionCard(row, total, open) {
  const delta = row.bpmDelta;
  const notes = [delta === null ? 'Tempo unavailable' : (delta > 0 ? '+' : '') + Number(delta.toFixed(1)) + ' BPM'];
  if (row.halfTime) notes.push('Half/double-time match');
  if (row.artistSpacingBonus < 0) notes.push('Recent artist repeat');
  if (row.quality === 'limited') notes.push('Partial measurements');
  const number = row.index + 1;
  const score = row.quality === 'limited' ? '' : '<br>' + Math.round(row.score * 100) + '/100';
  return `<div class="diagnostic transition ${row.quality}" role="listitem" aria-posinset="${number}" aria-setsize="${total}">
    <span class="transition-index">${number}</span>
    <div><strong>${html(row.fromTitle || 'Untitled')} → ${html(row.toTitle || 'Untitled')}</strong>
      <details class="pair-details" data-index="${row.index}"${open ? ' open' : ''}><summary>${notes.join(' · ')}</summary>${open ? breakdown(row) : ''}</details>
    </div><span class="quality">${grades[row.quality]}${score}</span>
  </div>`;
}

export function createTransitionList(host, diagnostics) {
  let tracks = [], options;
  const expanded = new Set();
  const nearby = new Set();
  const mounted = new Map();

  function render(block) {
    const start = Number(block.dataset.start);
    const rows = diagnostics(tracks, options, start, blockSize);
    mounted.set(block, rows);
    block.innerHTML = rows.map((row) => transitionCard(row, tracks.length - 1, expanded.has(row.index))).join('');
    block.style.height = 'auto';
  }

  function release(block) {
    if (!mounted.has(block) || nearby.has(block) || block.contains(document.activeElement)) return;
    // Retain the measured space, including wrapped titles and expanded details.
    const height = block.getBoundingClientRect().height;
    if (!height) return;
    block.style.height = height + 'px';
    block.replaceChildren();
    mounted.delete(block);
  }

  const observer = new IntersectionObserver((entries) => {
    if (!host.clientHeight) return;
    const atEnd = host.scrollTop > 0 && host.scrollHeight - host.clientHeight - host.scrollTop < 2;
    for (const { target: block, isIntersecting } of entries) {
      if (block.parentElement !== host) continue;
      if (isIntersecting) {
        nearby.add(block);
        if (!mounted.has(block)) render(block);
      } else {
        nearby.delete(block);
        release(block);
      }
    }
    if (atEnd) host.scrollTop = host.scrollHeight;
  }, { root: host, rootMargin: '360px 0px' });

  host.addEventListener('toggle', ({ target }) => {
    if (!target.matches('.pair-details')) return;
    const index = Number(target.dataset.index);
    if (target.open) {
      expanded.add(index);
      if (!target.querySelector('dl')) {
        const block = target.closest('.transition-block');
        const row = mounted.get(block)[index - Number(block.dataset.start)];
        target.insertAdjacentHTML('beforeend', breakdown(row));
      }
    } else expanded.delete(index);
  }, true);

  host.addEventListener('focusout', ({ target }) => {
    const block = target.closest('.transition-block');
    if (block && !nearby.has(block)) queueMicrotask(() => release(block));
  });

  function setTracks(next, settings) {
    observer.disconnect();
    nearby.clear();
    mounted.clear();
    expanded.clear();
    tracks = next;
    options = settings;
    const count = Math.max(0, tracks.length - 1);
    const fragment = document.createDocumentFragment();
    for (let start = 0; start < count; start += blockSize) {
      const block = document.createElement('div');
      block.className = 'transition-block';
      block.setAttribute('role', 'presentation');
      block.dataset.start = start;
      block.style.setProperty('--pairs', Math.min(blockSize, count - start));
      fragment.append(block);
    }
    host.replaceChildren(fragment);
    host.scrollTop = 0;
    const first = host.firstElementChild;
    if (first) {
      render(first);
      const height = first.getBoundingClientRect().height;
      if (height) host.style.setProperty('--pair-height', height / Math.min(count, blockSize) + 'px');
      for (const block of host.children) observer.observe(block);
    }
  }

  return {
    setTracks,
    setOptions(settings) {
      options = settings;
      for (const block of mounted.keys()) render(block);
    },
  };
}
