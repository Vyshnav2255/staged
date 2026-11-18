// Settings: Commit Compass, repositories, message style, sound and updates.
import { icon } from './icons.js';
import { esc, toast } from './ui.js';
import * as ai from './ai.js';
import { soundOn, setSound, sfxGrouped } from './sfx.js';
import { previewCommit, previewPush } from './fx.js';
import { checkNow } from './update.js';

let host = null, ctx = null, st = null, repoInfo = null, stats = null, scan = null, fresh = new Set();
const commitStore = {
  get() { try { return JSON.parse(localStorage.getItem('changes.commit') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('changes.commit', JSON.stringify(v)); } catch {} },
};

export async function mountSettings(el, context) {
  host = el; ctx = context;
  if (!host.dataset.bound) { host.addEventListener('click', onClick); host.addEventListener('change', onChange); host.addEventListener('pointerdown', onHold); host.dataset.bound = '1'; }
  await refresh();
  if (ctx.section) host.querySelector(`#set-${ctx.section}`)?.scrollIntoView({ block: 'start' });
}

async function refresh() {
  st = await ai.status();
  [stats, repoInfo] = await Promise.all([
    fetch('/api/changes/engine-stats').then((r) => r.json()).catch(() => null),
    fetch('/api/repos/manage').then((r) => r.json()).catch(() => null),
  ]);
  draw();
}

function draw() {
  if (!host || host.hidden) return;
  const fmt = commitStore.get().format || 'gitmoji';
  // The page redraws when staged refreshes in the background; keep whatever you were typing.
  const typing = host.contains(document.activeElement) && document.activeElement.matches('input[name]') ? { name: document.activeElement.name, value: document.activeElement.value, at: document.activeElement.selectionStart } : null;
  host.innerHTML = `
  <div class="set">
    ${reposSection()}
    ${aiSection()}

    <section class="set-sec" id="set-messages">
      <header class="set-h"><h2>Commit messages</h2></header>
      <div class="set-card">
        <div class="set-row">
          <div class="set-row-main"><b>Style</b><span class="muted">${fmt === 'conventional' ? 'feat(books): add notes for …' : fmt === 'both' ? '✨ feat(books): add notes for …' : '✨ Added book notes for …'}</span></div>
          <div class="seg set-seg scroll-fade-x" role="radiogroup" aria-label="Message style">
            ${[['gitmoji', 'Gitmoji'], ['conventional', 'Conventional'], ['both', 'Both']].map(([k, l]) => `<button role="radio" aria-checked="${fmt === k}" data-format="${k}">${l}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="set-sec" id="set-feel">
      <header class="set-h"><h2>Sound and motion</h2></header>
      <div class="set-card">
        <label class="set-row is-toggle">
          <div class="set-row-main"><b>Sounds</b><span class="muted">Soft sounds when you commit, push and discard. Made on the fly, nothing to download.</span></div>
          <span class="switch"><input type="checkbox" data-sound ${soundOn() ? 'checked' : ''}><i></i></span>
        </label>
        <div class="set-row">
          <div class="set-row-main"><b>Try them</b><span class="muted">Plays the moments without committing or pushing anything. Motion follows your system's reduce-motion setting.</span></div>
          <div class="set-btns"><button class="text-btn bordered sm" data-preview="commit">Commit</button><button class="text-btn bordered sm" data-preview="push">Push</button></div>
        </div>
      </div>
    </section>

    <section class="set-sec" id="set-updates">
      <header class="set-h"><h2>Updates</h2></header>
      <div class="set-card">
        <div class="set-row">
          <div class="set-row-main"><b>staged ${esc(ctx.version || '')}</b><span class="muted">New releases on GitHub show up in the sidebar within a few hours.</span></div>
          <button class="text-btn bordered sm" data-check>${icon('Refresh01', 13)}Check now</button>
        </div>
      </div>
    </section>
  </div>`;
  if (typing) { const el = host.querySelector(`input[name="${typing.name}"]`); if (el) { el.value = typing.value; el.focus(); try { el.setSelectionRange(typing.at, typing.at); } catch {} } }
}
// ---------- Settings › AI ----------
// One picker for who does the work, and a panel underneath for whichever engine is open: its key,
// its downloads, or why it isn't available.
const ENGINE_ICON = { auto: 'Sparkles', online: 'Globe02', local: 'Laptop', chrome: 'Browser', browser: 'Cpu', claude: 'AiMagic', rules: 'Built-in rules' };
const ENGINE_NAME = { auto: 'Best available', online: 'Online model', local: 'Open model on this computer', chrome: 'Browser built-in AI', browser: 'Small model in this page', claude: 'Claude Code', rules: 'Built-in rules' };
const ENGINE_LINE = {
  auto: 'staged picks the best one that is ready.',
  online: 'A large model on the internet, with your own key. Nothing to download.',
  local: 'Gemma, downloaded once and run on this computer. Private and offline.',
  chrome: 'The model some browsers offer to pages. Nothing to install.',
  browser: 'A tiny model that runs inside this page.',
  claude: 'The Claude Code app on this computer, with your account.',
  rules: 'staged reads the diff and writes from patterns. Instant.',
};
const gb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
function engineState(k) {
  if (k === 'auto') { const using = ['online', 'local', 'chrome', 'browser', 'claude'].find((e) => st[e] === 'ready') || 'rules'; return `<span class="ai-tag is-ready">${icon('Tick02', 11)}using ${esc(ENGINE_NAME[using].replace(' on this computer', '').replace(' in this page', ''))}</span>`; }
  const s = k === 'online' ? onl.state : k === 'local' ? loc.state : st[k];
  if (s === 'ready') return `<span class="ai-tag is-ready ${justReady === k ? 'is-new' : ''}">${icon('Tick02', 11)}ready</span>`;
  if (s === 'busy') return `<span class="ai-tag">${k === 'local' ? 'downloading' : 'getting ready'}</span>`;
  if (s === 'setup') return `<span class="ai-tag is-todo">${k === 'online' ? 'needs a key' : k === 'chrome' ? 'turn on' : 'download'}</span>`;
  return '<span class="ai-tag is-no">not available</span>';
}
function legacyAiSection() {
  const want = ai.preferred('write'), wantG = ai.preferredRaw('group');
  const open = focus || want;
  const card = (k) => {
    const off = k !== 'auto' && k !== 'online' && k !== 'local' && st[k] === 'no';
    return `<button class="ai-card ${want === k ? 'is-on' : ''} ${open === k ? 'is-open' : ''} ${off ? 'is-off' : ''}" role="radio" aria-checked="${want === k}" data-aicard="${k}">
      <span class="ai-ico">${icon(ENGINE_ICON[k], 17)}</span>
      <span class="ai-main"><b>${ENGINE_NAME[k]}</b><span class="muted">${ENGINE_LINE[k]}</span></span>
      <span class="ai-side">${engineState(k)}<i class="ai-radio"></i></span>
    </button>`;
  };
  return `<section class="set-sec" id="set-ai">
      <header class="set-h"><h2>AI</h2><p class="muted">Who writes your commit messages and sorts changes into commits. Pick one, or leave it on <b>Best available</b>.</p></header>
      <div class="ai-grid" role="radiogroup" aria-label="Who does the work">${ORDER.map(card).join('')}</div>
      <div class="set-card ai-panel" data-panel="${open}">${panel(open)}</div>
      <div class="set-card ai-more">
        <div class="set-row">
          <div class="set-row-main"><b>Sorting changes into commits</b><span class="muted">staged always sorts first, from real links between your changes. Regroup then asks a model to check it: an online model or Claude re-sorts every chunk, a model on this computer joins commits that belong together, and the lightest model only writes.</span></div>
          <label class="ai-select"><select data-groupengine aria-label="Who sorts changes into commits">
            <option value="same" ${wantG === 'same' ? 'selected' : ''}>Same as above</option>
            ${ORDER.filter((k) => k !== 'auto' && k !== 'browser' && k !== 'chrome').map((k) => `<option value="${k}" ${wantG === k ? 'selected' : ''}>${ENGINE_NAME[k]}</option>`).join('')}
          </select>${icon('ArrowDown01', 13)}</label>
        </div>
        <label class="set-row is-toggle">
          <div class="set-row-main"><b>Regroup when changes load</b><span class="muted">Let the AI sort your changes as soon as you open the Commit tab. Off means staged's rules group first and you press Regroup when you want it.</span></div>
          <span class="switch"><input type="checkbox" data-autogroup ${ai.autoGroup() ? 'checked' : ''}><i></i></span>
        </label>
      </div>
    </section>`;
}
const panelHead = (k, extra = '') => `<div class="ai-phead"><span class="ai-ico is-big">${icon(ENGINE_ICON[k], 20)}</span><div class="set-row-main"><b>${ENGINE_NAME[k]}</b><span class="muted">${extra}</span></div></div>`;
function panel(k) {
  if (k === 'online') return onlinePanel();
  if (k === 'local') return localPanel();
  if (k === 'browser') return pagePanel();
  if (k === 'auto') {
    const order = ['online', 'local', 'chrome', 'browser', 'claude'];
    return `${panelHead('auto', 'staged tries these in order and uses the first that is ready. Rules are always there as the last resort.')}
      <ol class="ai-order">${order.map((e) => `<li class="${order.find((x) => st[x] === 'ready') === e ? 'is-using' : ''}"><button class="ai-jump" data-aifocus="${e}">${icon(ENGINE_ICON[e], 14)}${ENGINE_NAME[e]}</button>${engineState(e)}</li>`).join('')}</ol>`;
  }
  if (k === 'chrome') return panelHead('chrome', esc(ai.ENGINES.chrome.note)) + (st.chrome === 'setup' ? `<div class="ai-pact"><button class="text-btn bordered sm" data-setup="chrome" ${busy ? 'disabled' : ''}>${icon('Download04', 13)}Turn on</button>${busy === 'chrome' ? progress() : ''}</div>` : st.chrome === 'no' ? '<p class="ai-pnote mono">This browser does not offer it.</p>' : '');
  if (k === 'claude') return panelHead('claude', esc(ai.ENGINES.claude.note)) + (st.claude === 'no' ? '<p class="ai-pnote mono">Claude Code was not found on this computer.</p>' : '');
  return panelHead('rules', esc(ai.ENGINES.rules.note) + ' It also makes the first grouping every time, which the AI then improves.');
}
// Online: pick a service, paste a key, test it.
function onlinePanel() {
  const p = onl.providers?.find((x) => x.key === onl.provider) || { label: '', note: '', keys: '', model: '' };
  const model = od.model ?? onl.model ?? '', url = od.url ?? (onl.provider === 'custom' ? onl.url : '') ?? '';
  return `${panelHead('online', 'The sharpest option, and nothing to download. staged sends only the changes it is writing about to the service you choose. Your key stays on this computer.')}
    <div class="ai-prov scroll-fade-x" role="radiogroup" aria-label="Service">${(onl.providers || []).map((x) => `<button role="radio" aria-checked="${x.key === onl.provider}" data-provider="${x.key}">${esc(x.label)}${x.hasKey ? `<i class="ai-dot" title="Key saved"></i>` : ''}</button>`).join('')}</div>
    <p class="ai-pnote">${esc(p.note)}${p.keys ? ` <a href="${esc(p.keys)}" target="_blank" rel="noopener">Get a key${icon('ArrowRight01', 11)}</a>` : ''}</p>
    <div class="ai-form">
      ${onl.provider === 'custom' ? `<label class="ai-field is-wide"><span>Address</span><input name="ourl" type="url" spellcheck="false" autocomplete="off" placeholder="https://api.example.com/v1" value="${esc(url)}"></label>` : ''}
      <label class="ai-field"><span>Key</span><span class="ai-key"><input name="okey" type="${od.show ? 'text' : 'password'}" spellcheck="false" autocomplete="off" placeholder="${onl.keyHint ? `Saved ${esc(onl.keyHint)} · paste a new one to replace it` : 'Paste your key'}" value="${esc(od.key)}"><button type="button" class="ai-eye" data-showkey title="${od.show ? 'Hide' : 'Show'}" aria-label="${od.show ? 'Hide key' : 'Show key'}">${icon(od.show ? 'ViewOff' : 'View', 14)}</button></span></label>
      <label class="ai-field"><span>Model</span><input name="omodel" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(p.model || 'model name')}" value="${esc(model)}"></label>
    </div>
    <div class="ai-pact">
      <button class="btn-primary sm" data-onlinesave ${busy === 'online' ? 'disabled' : ''}>${busy === 'online' ? 'Checking…' : onl.keyHint && !od.key ? 'Test it' : 'Save and test'}</button>
      ${onl.keyHint ? `<button class="text-btn is-danger-soft sm" data-onlineforget>${icon('Delete02', 13)}Forget key</button>` : ''}
      ${otest ? `<span class="ai-test ${otest.ok ? 'is-ok' : 'is-bad'}">${icon(otest.ok ? 'Tick02' : 'Alert02', 13)}<span>${esc(otest.text)}</span></span>` : ''}
    </div>`;
}
// The open model on this computer: three sizes side by side.
function localPanel() {
  const p = loc.progress, busyK = loc.state === 'busy' ? p?.model : '';
  const viaOllama = loc.via === 'ollama' ? `<p class="ai-pnote mono">${icon('Tick02', 12)} Using ${esc(loc.ollama)} from Ollama, which is already running. Download one below to use staged's own instead.</p>` : '';
  return `${panelHead('local', 'An open model by Google, run by llama.cpp, the open-source engine most local AI apps use. One download, then it works offline. It uses memory only while working and for a few minutes after.')}
    ${loc.state === 'no' && loc.reason ? `<p class="ai-pnote mono">${esc(loc.reason.replace(/^./, (c) => c.toUpperCase()))}</p>` : ''}${viaOllama}
    ${loc.error ? `<p class="set-err">${icon('Alert02', 13)}<span>The last download didn't finish: ${esc(loc.error)}. Press the button again to carry on from where it stopped.</span></p>` : ''}
    <div class="ai-sizes">${(loc.models || []).map((m) => {
      const have = m.bytes > 0, on = have && loc.model === m.key, mine = busyK === m.key;
      return `<div class="ai-size ${on ? 'is-on' : ''} ${have ? 'is-have' : ''}" ${have && !on ? `data-localchoose="${m.key}" role="button" tabindex="0" title="Use this one"` : ''}>
        <span class="ai-size-top"><span class="set-tag mono">${esc(m.tag)}</span>${on ? `<span class="ai-tag is-ready">${icon('Tick02', 11)}${loc.loaded === m.key ? 'running' : 'in use'}</span>` : have ? '<span class="ai-tag">downloaded</span>' : ''}</span>
        <b class="ai-size-n">${gb(have ? m.bytes : m.size).replace(' ', '<small> ')}</small></b>
        <span class="ai-size-name">${esc(m.label)}</span>
        <span class="muted ai-size-note">${esc(m.note)}</span>
        ${mine ? `<div class="wr-progress"><div class="wr-bar"><i style="transform:scaleX(${Math.max(0.02, p.ratio || 0)})"></i></div><span class="wr-step mono">${esc(p.text || 'Starting')}</span></div>` : ''}
        <span class="ai-size-act">${mine ? `<button class="text-btn bordered sm" data-localcancel>Pause</button>`
          : have ? `<button class="text-btn is-danger-soft sm" data-localdelete="${m.key}" ${busyK ? 'disabled' : ''}>${icon('Delete02', 13)}Remove</button>`
          : `<button class="text-btn bordered sm" data-localsetup="${m.key}" ${busyK || loc.state === 'no' ? 'disabled' : ''}>${icon('Download04', 13)}${m.part ? `Carry on · ${gb(m.part)} here` : 'Download'}</button>`}</span>
      </div>`;
    }).join('')}</div>`;
}
// The tiny in-page models, and whatever older downloads are still on disk.
function pagePanel() {
  return `${panelHead('browser', "A much smaller model (1B) that runs inside this page with WebGPU. Fine for a quick subject line, not for grouping. Prefer the open model on this computer if it runs here.")}
    ${ai.lastError() && !busy ? `<p class="set-err">${icon('Alert02', 13)}<span>The last download didn't finish: ${esc(ai.lastError())}</span></p>` : ''}
    <div class="ai-sizes">${Object.entries(ai.MODELS).map(([k, m]) => {
      const on = ai.modelChoice() === k, have = ai.isDownloaded(k);
      return `<div class="ai-size ${on ? 'is-on' : ''} ${have ? 'is-have' : ''}" ${on ? '' : `data-pagechoose="${k}" role="button" tabindex="0" title="Use this one"`}>
        <span class="ai-size-top"><span class="set-tag mono">${esc(m.by)}</span>${on ? `<span class="ai-tag ${have ? 'is-ready' : ''}">${have ? icon('Tick02', 11) : ''}${have ? 'in use' : 'picked'}</span>` : have ? '<span class="ai-tag">downloaded</span>' : ''}</span>
        <b class="ai-size-n">${(sizes[k] ? bytes(sizes[k]) : m.size.replace('about ', '')).replace(' ', '<small> ')}</small></b>
        <span class="ai-size-name">${esc(m.label)}</span>
        <span class="muted ai-size-note">${esc(m.note)}</span>
        ${busy === k ? progress() : ''}
        <span class="ai-size-act">${have ? `<button class="text-btn is-danger-soft sm" data-remove="${k}" ${busy ? 'disabled' : ''}>${icon('Delete02', 13)}Remove</button>` : `<button class="text-btn bordered sm" data-download="${k}" ${busy ? 'disabled' : ''}>${icon('Download04', 13)}Download</button>`}</span>
      </div>`;
    }).join('')}</div>
    ${stored.length ? `<div class="ai-store"><div class="set-row-main"><b>On disk</b><span class="muted">${bytes(stored.reduce((s, x) => s + x.bytes, 0))} of in-page models. Delete any you don't use.</span></div>
      <div class="set-store">${stored.map((x) => `<div class="set-store-row"><span class="set-store-name">${esc(x.key ? ai.MODELS[x.key].label : x.id.split('/').pop())}${x.key ? '' : ' <span class="set-tag is-old mono">no longer offered</span>'}</span><span class="mono muted">${x.bytes ? bytes(x.bytes) : '–'}</span><button class="text-btn is-danger-soft sm" data-delete="${esc(x.id)}" ${busy ? 'disabled' : ''}>${icon('Delete02', 13)}Delete</button></div>`).join('')}
      ${stored.length > 1 ? `<div class="set-store-row is-all"><span></span><span></span><button class="text-btn is-danger-soft sm" data-delete="*" ${busy ? 'disabled' : ''}>Delete all</button></div>` : ''}</div></div>` : ''}`;
}
// While a download runs, the bar follows staged's server; closing the page doesn't stop it.
let localT = null;
function watchLocal() {
  clearTimeout(localT);
  localT = setTimeout(async () => {
    if (!host || host.hidden) return;
    const was = loc;
    loc = await ai.localStatus(true);
    if (loc.state === 'busy' && was.state === 'busy' && loc.progress?.model === was.progress?.model) {
      const row = host.querySelector('.ai-size .wr-progress');
      const bar = row?.querySelector('.wr-bar i'), step = row?.querySelector('.wr-step');
      if (bar) bar.style.transform = `scaleX(${Math.max(0.02, loc.progress.ratio || 0)})`;
      if (step) step.textContent = loc.progress.text || '';
      return watchLocal();
    }
    if (was.state === 'busy' && loc.state === 'ready' && !loc.error) { justReady = 'local'; setTimeout(() => { justReady = ''; }, 1000); toast(`${loc.models.find((m) => m.key === loc.model)?.label || 'The model'} is ready`); }
    else if (loc.error) toast(`Couldn't finish the download: ${loc.error}`);
    await refresh(); ctx.onChange?.();
  }, 700);
}
// Settings › Repos: the folders staged looks in (every git repo inside, up to three levels down, shows
// up), single repos added on their own, folders that aren't repos yet, and a switch per repo to hide it.
// Compact rules-first controls and useful evidence live here, away from the commit workflow.
function aiSection() {
  const x = stats || {};
  const fmt = (v) => Number(v || 0).toLocaleString();
  const plural = (n, one, many = one + 's') => `${fmt(n)} ${Number(n) === 1 ? one : many}`;
  const score = Number.isFinite(x.currentScore) ? Math.round(x.currentScore * 100) : null;
  const style = x.style || {};
  const format = String(style.format || 'gitmoji').toLowerCase(), tense = String(style.tense || 'past').toLowerCase();
  const verb = tense.startsWith('imp') ? 'Add' : 'Added';
  // An example in the style it learned from you, so the numbers below mean something.
  const sample = format.startsWith('conv') ? 'feat(ui): add a close handle to sheets'
    : format === 'plain' ? `${verb} a close handle to sheets` : `✨ ${verb} a close handle to sheets`;
  const fixes = Number(x.learnedTogether || 0) + Number(x.learnedApart || 0);
  const steps = [
    ['GitCommit', 'Reads your history', plural(x.commits, 'commit'), `across ${plural(x.repositories, 'repo')}, ${plural(x.indexedFiles, 'file')}`],
    ['Layers01', 'Sorts the changes', plural(x.recurringPathPairs, 'file pair'), fixes ? `that change together, plus ${plural(fixes, 'fix', 'fixes')} you made` : 'that usually change together'],
    ['PencilEdit02', 'Writes the message', `${style.averageSubjectLength ? Math.round(style.averageSubjectLength) : '–'} chars`, `on average, ${format.startsWith('conv') ? 'conventional' : format === 'plain' ? 'plain' : 'gitmoji'}, ${tense.startsWith('imp') ? 'imperative' : 'past'} tense`],
  ];
  return `<section class="set-sec" id="set-ai">
    <header class="set-h"><h2>Commit engine</h2><p class="muted">How staged sorts your changes into commits and writes their messages.</p></header>
    <div class="set-card eng">
      <div class="eng-head">
        <span class="eng-mark">${icon('Target02', 18)}</span>
        <div class="set-row-main"><b>Commit Compass</b><span class="muted">Runs on this computer and learns from your Git history. Nothing is sent anywhere.</span></div>
        <span class="eng-on"><i></i>Ready</span>
      </div>
      <ol class="eng-steps">${steps.map(([ic, title, big, small], i) => `
        <li class="eng-step">
          <span class="eng-step-h"><span class="eng-n mono">${i + 1}</span>${icon(ic, 14)}${title}</span>
          <strong class="eng-big">${esc(big)}</strong>
          <span class="eng-small muted">${esc(small)}</span>
        </li>`).join('')}
      </ol>
      <div class="eng-foot">
        <div class="eng-sample"><span class="eng-label">Writes like you</span><code class="mono">${esc(sample)}</code></div>
        <div class="eng-score">${score == null
          ? '<span class="eng-label">Confidence</span><span class="muted">Shows with your next changes</span>'
          : `<span class="eng-label">Confidence today</span><span class="eng-meter" role="meter" aria-label="Confidence in today's suggested commits" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><i style="--score:${score}%"></i></span><b class="mono">${score}%</b>${x.currentScoreReviewGroups ? `<span class="muted">${plural(x.currentScoreReviewGroups, 'commit')} to check</span>` : ''}`}
        </div>
      </div>
    </div>
  </section>`;
}

const TINTS = ['var(--logo-1)', 'var(--logo-2)', 'var(--logo-box)'];
const tint = (name) => TINTS[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % TINTS.length];
const parentOf = (p) => p.replace(/\/[^/]+\/?$/, '');
function reposSection() {
  if (!repoInfo) return '';
  const { folders, repos, plain = [] } = repoInfo;
  const count = (f) => repos.filter((r) => r.path.startsWith(f.path + '/')).length;
  const off = scan ? 'disabled' : '';
  const shown = repos.filter((r) => !r.hidden).length;
  const isRoot = (r) => folders.some((f) => f.kind === 'folder' && f.path === r.path);
  let n = 0;
  const folderRow = (f) => `<div class="rp-folder" style="--d:${n++}">
      <span class="rp-ftile">${icon(f.kind === 'repo' ? 'GitBranch' : 'Folder01', 16)}</span>
      <span class="rp-fmain"><b>${esc(short(f.path))}</b><span class="mono muted">${esc(f.path)}</span></span>
      <span class="rp-count mono">${f.kind === 'repo' ? 'one repo' : `${count(f)} ${count(f) === 1 ? 'repo' : 'repos'}`}</span>
      <button class="rp-x" data-unfolder="${esc(f.path)}" ${folders.length < 2 || scan ? 'disabled' : ''} title="${folders.length < 2 ? 'staged needs at least one folder' : 'Stop looking here'}" aria-label="Remove ${esc(f.path)}">${icon('Cancel01', 14)}</button>
    </div>`;
  const repoTile = (r) => `<div class="rp-tile ${r.hidden ? 'is-off' : ''} ${fresh.has(r.path) ? 'is-new' : ''}" style="--i:${Math.max(0, [...fresh].indexOf(r.path))}" data-tile="${esc(r.path)}">
      <span class="rp-mono ${r.logo ? 'has-logo' : ''}" style="--t:${tint(r.name)}">${r.logo ? `<img src="/api/repos/logo?path=${encodeURIComponent(r.path)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('has-logo');this.remove()">` : ''}<i>${esc(r.name.replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || '·')}</i></span>
      <span class="rp-tmain"><b title="${esc(r.path)}">${esc(r.name)}</b><span class="mono muted"><span class="rp-where">${esc(parentOf(r.path))}</span><span class="rp-hold">removing git…</span></span></span>
      ${isRoot(r) ? '<span></span>' : `<button class="rp-ungit" data-ungit="${esc(r.path)}" ${off} title="Hold to remove git. The files stay; the history goes to the Trash, so it can come back." aria-label="Remove git from ${esc(r.name)}">${icon('Delete02', 14)}</button>`}
      <label class="switch" title="${r.hidden ? 'Hidden. Turn on to show it in staged' : 'Shown in staged'}"><input type="checkbox" data-showrepo="${esc(r.path)}" ${r.hidden ? '' : 'checked'} aria-label="Show ${esc(r.name)}"><i></i></label>
    </div>`;
  const plainTile = (f) => `<div class="rp-tile is-plain">
      <span class="rp-mono is-plain">${icon('Folder01', 15)}</span>
      <span class="rp-tmain"><b>${esc(f.name)}</b><span class="mono muted">${esc(parentOf(f.path))}</span></span>
      <button class="text-btn bordered sm rp-init" data-init="${esc(f.path)}" ${off}>${icon('GitBranch', 13)}Turn on git</button>
    </div>`;
  return `<section class="set-sec rp" id="set-repos">
    <header class="set-h"><h2>Repos</h2><p class="muted">staged finds every git repo inside your folders, up to three levels down.</p></header>
    <div class="set-card rp-card">
      <div class="rp-head"><b>Where staged looks</b></div>
      <div class="rp-folders">${folders.map(folderRow).join('')}</div>
      ${scan ? scanRow() : ''}
      <div class="rp-actions">
        <button class="text-btn bordered sm" data-pick="parent" ${off}>${icon('Add01', 13)}Add a folder</button>
        <button class="text-btn bordered sm" data-pick="repo" ${off}>${icon('GitBranch', 13)}Add one repo</button>
        <button class="text-btn sm rp-rescan" data-rescan ${off}><span class="rp-spin">${icon('Refresh', 13)}</span>Scan again</button>
      </div>
    </div>
    <div class="rp-sub"><b>Your repos</b><span class="mono muted">${shown === repos.length ? `${repos.length} shown` : `${shown} of ${repos.length} shown`}</span></div>
    <div class="rp-grid">${repos.map(repoTile).join('') || '<p class="muted rp-none">No repos yet. Add a folder above.</p>'}</div>
    ${plain.length ? `<div class="rp-sub"><b>Not git repos yet</b><span class="mono muted">staged can't see these until git is on</span></div>
    <div class="rp-grid">${plain.map(plainTile).join('')}</div>` : ''}
  </section>`;
}

const scanRow = () => `<div class="set-scan ${scan.found != null ? 'is-done' : ''}" role="status" aria-live="polite">
  <span class="set-scan-ic">${icon(scan.found != null ? 'Tick02' : 'Search01', 14)}</span>
  <span class="set-scan-text"><b>${esc(scan.found != null ? scan.result : scan.label)}</b><span class="set-scan-tick mono">${esc(scan.tick)}</span></span>
  <span class="set-scan-bar" aria-hidden="true"><i></i></span>
</div>`;

async function post(body) {
  const r = await fetch('/api/repos/manage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || "Couldn't change that"); return null; }
  return j;
}
async function manage(body) {
  const j = await post(body);
  if (!j) return false;
  repoInfo = j; draw(); ctx.onRepos?.();
  return true;
}

// Adding or rescanning a folder: a short scan with the folder names ticking past, then the repos it
// found drop into the list one after another, with a soft sound.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function scanWith(label, body, done) {
  const before = new Set((repoInfo?.repos || []).map((r) => r.path));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scan = { label, tick: 'Looking through folders…' }; draw();
  const t0 = performance.now();
  const j = await post(body);
  if (!j) { scan = null; draw(); return null; }
  const added = j.repos.filter((r) => !before.has(r.path));
  const tick = (t) => { scan.tick = t; const el = host.querySelector('.set-scan-tick'); if (el) { el.textContent = t; el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in'); } };
  if (!calm) {
    const names = [...j.repos, ...(j.plain || [])].map((r) => r.name).slice(0, 16);
    for (const n of names) { tick(n); await wait(Math.max(45, 520 / names.length)); }
    const left = 900 - (performance.now() - t0);
    if (left > 0) await wait(left);
  }
  scan.found = added.length;
  scan.result = done(added, j);
  tick(added.length ? added.slice(0, 3).map((r) => r.name).join(', ') + (added.length > 3 ? ` and ${added.length - 3} more` : '') : (j.plain || []).length ? `${j.plain.length} ${j.plain.length === 1 ? 'folder isn’t' : 'folders aren’t'} git repos yet` : 'Nothing new');
  const row = host.querySelector('.set-scan');
  if (row) { row.classList.add('is-done'); row.querySelector('b').textContent = scan.result; row.querySelector('.set-scan-ic').innerHTML = icon('Tick02', 14); }
  await wait(calm ? 300 : 900);
  repoInfo = j; scan = null;
  fresh = new Set(added.map((r) => r.path));
  draw(); ctx.onRepos?.();
  if (added.length) sfxGrouped(Math.min(5, added.length));
  setTimeout(() => { fresh = new Set(); }, 2000);
  return { j, added };
}
const short = (p) => String(p).replace(/\/$/, '').split('/').pop() || p;
const foundText = (added) => (added.length ? `Found ${added.length} ${added.length === 1 ? 'repo' : 'repos'}` : 'No new repos');
const addPath = (p) => scanWith(`Scanning ${short(p)}`, { action: 'add', path: p }, foundText);

const progress = () => `<span class="wr-progress"><span class="wr-bar"><i style="transform:scaleX(${Math.max(0.02, prog.r)})"></i></span><span class="wr-step mono">${esc(prog.text || 'Starting…')}</span></span>`;

// Remove git: hold for 1.5s (let go to cancel). The .git folder goes to the Trash, with Undo.
const HOLD_MS = 1500;
function onHold(e) {
  const b = e.target.closest('[data-ungit]');
  if (!b || b.disabled || e.button > 0) return;
  const tile = b.closest('.rp-tile');
  tile.classList.add('is-holding');
  const t0 = Date.now();
  const done = setTimeout(() => { stop(); ungit(b.dataset.ungit); }, HOLD_MS);
  const stop = () => { clearTimeout(done); tile.classList.remove('is-holding'); for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.removeEventListener(k, early); };
  const early = () => { if (Date.now() - t0 < HOLD_MS) { stop(); if (Date.now() - t0 < 300) toast('Hold the button to remove git'); } };
  for (const k of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(k, early);
}
async function ungit(p) {
  const n = short(p), tile = host.querySelector(`[data-tile="${CSS.escape(p)}"]`);
  if (tile && !matchMedia('(prefers-reduced-motion: reduce)').matches) { tile.classList.add('is-leaving'); await wait(260); }
  if (!(await manage({ action: 'ungit', path: p }))) { tile?.classList.remove('is-leaving'); return; }
  toast(`Removed git from ${n}. Its history is in the Trash.`, { action: 'Undo', ms: 8000, onAction: async () => { if (await manage({ action: 'regit', path: p })) { fresh = new Set([p]); draw(); setTimeout(() => { fresh = new Set(); }, 2000); toast(`${n} is a git repo again`); } } });
}

async function onClick(e) {
  let b;
  if ((b = e.target.closest('[data-pick]'))) {
    // staged's server opens the computer's own folder picker, since a web page can't see full paths.
    b.disabled = true;
    try {
      const r = await fetch('/api/repos/pick', { method: 'POST', headers: { 'content-type': 'application/json', 'x-changes': '1' }, body: JSON.stringify({ kind: b.dataset.pick }) }).then((x) => x.json());
      if (r.error) toast(r.error);
      else if (r.path) await addPath(r.path);
    } finally { b.disabled = false; }
    return;
  }
  if ((b = e.target.closest('[data-ungit]'))) { if (e.detail === 0) ungit(b.dataset.ungit); return; } // keyboard: no hold needed, Undo covers it
  if ((b = e.target.closest('[data-rescan]'))) { await scanWith('Scanning your folders', { action: 'scan' }, foundText); return; }
  if ((b = e.target.closest('[data-init]'))) {
    const p = b.dataset.init, n = short(p);
    const r = await scanWith(`Turning on git in ${n}`, { action: 'init', path: p }, () => `${n} is a git repo now`);
    if (r) toast(`${n} now shows in staged. Make its first commit from the Commit tab.`);
    return;
  }
  if ((b = e.target.closest('[data-unfolder]'))) { if (await manage({ action: 'remove', path: b.dataset.unfolder })) toast(`Removed ${b.dataset.unfolder}`); return; }
  if ((b = e.target.closest('[data-format]'))) { const v = commitStore.get(); v.format = b.dataset.format; commitStore.set(v); draw(); ctx.onChange?.(); return; }
  if ((b = e.target.closest('[data-preview]'))) { b.dataset.preview === 'commit' ? previewCommit() : previewPush(); return; }
  if ((b = e.target.closest('[data-check]'))) return checkNow();
}
function onChange(e) {
  const el = e.target;
  if (el.matches('[data-showrepo]')) { manage({ action: el.checked ? 'show' : 'hide', path: el.dataset.showrepo }); return; }
  if (el.matches('[data-sound]')) { setSound(el.checked); return; }
}
