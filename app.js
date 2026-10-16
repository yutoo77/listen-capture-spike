/* Audio Technical Spike v0.2 - no backend, no frameworks, no uploads.
 * Recording and experimental bookmarks are stored in origin-scoped IndexedDB.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const audio = $('player');
const nodes = {
  playToggle: $('playToggle'), recordToggle: $('recordToggle'), recordIcon: $('recordIcon'),
  recordLabel: $('recordLabel'), rewind: $('rewind'), bookmark: $('bookmark'),
  currentTime: $('currentTime'), duration: $('duration'), seek: $('seek'),
  file: $('audioFile'), useDemo: $('useDemo'), trackName: $('trackName'),
  trackSubtitle: $('trackSubtitle'), status: $('status'), memos: $('memos'),
  features: $('features'), log: $('eventLog'), exportLog: $('exportLog'),
  headsetTest: $('headsetTest'), recovery: $('unsavedRecordings'),
  captureClock: $('captureClock'), cancelStart: $('cancelStart')
};
// A path namespace avoids collisions, but does not isolate same-origin sites.
const DB_NAME = `listen-capture-spike-v2:${new URL('./', location.href).pathname}`;
const STORE = 'memos';
const logEntries = [];
const memoObjectUrls = [];
const DEMO_AUDIO = './assets/sample.mp3';
const DEMO_ID = 'listen-capture-demo-20261017-v1';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_RECORD_MS = 60_000;
const MAX_RECORD_BYTES = 12 * 1024 * 1024;
const recoveryMemos = new Map();
let userAudioUrl = null;
let trackLabel = '操作検証用の英語音声（デモ）';
let trackKind = 'demo';
let trackId = DEMO_ID;
let dbPromise = null;
let storageReady = false;
let captureSession = null;
let activeMemoAudio = null;
let renderRevision = 0;
let playbackOperation = 0;
let recorder = null;
let stream = null;
let chunks = [];
let captureReference = null;
let wasPlayingBeforeRecording = false;
let state = 'booting'; // booting | idle | loading | starting | recording | saving
let isSeeking = false;

function now() { return new Date().toISOString(); }
function stamp(message, details) {
  const entry = { at: now(), message, ...(details ? { details } : {}) };
  logEntries.push(entry);
  if (logEntries.length > 150) logEntries.shift();
  nodes.log.textContent = logEntries.slice(-40).map((it) => `${it.at.slice(11,19)} ${it.message}${it.details ? ' / ' + JSON.stringify(it.details) : ''}`).join('\n');
  nodes.log.scrollTop = nodes.log.scrollHeight;
}
function setStatus(text, warn = false) {
  nodes.status.textContent = text;
  nodes.status.classList.toggle('warning', warn);
}
function secTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const n = Math.floor(sec);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function canRecord() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}
function extensionFor(mime) {
  if (mime?.includes('mp4')) return 'm4a';
  if (mime?.includes('ogg')) return 'ogg';
  if (mime?.includes('webm')) return 'webm';
  return 'bin';
}
function id() {
  return crypto.randomUUID?.() ?? `memo-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
}
function openDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB がありません'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('DBが別タブで使用されています'));
    }).catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}
async function dbTransaction(mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = action(tx.objectStore(STORE));
    let result;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => { /* tx.onerror handles this */ };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('保存に失敗しました'));
    tx.onabort = () => reject(tx.error || new Error('処理が中断されました'));
  });
}
const putMemo = (memo) => dbTransaction('readwrite', store => store.put(memo));
const getMemos = () => dbTransaction('readonly', store => store.getAll());
const deleteMemo = (memoId) => dbTransaction('readwrite', store => store.delete(memoId));

function updatePlayback() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  nodes.currentTime.textContent = secTime(audio.currentTime);
  nodes.duration.textContent = secTime(duration);
  nodes.seek.setAttribute('aria-valuetext', `${secTime(audio.currentTime)} / ${secTime(duration)}`);
  if (!isSeeking) nodes.seek.value = duration ? Math.floor(1000 * audio.currentTime / duration) : '0';
  if (!activeMemoAudio && 'mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      if (duration > 0) navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate, position: Math.min(duration, audio.currentTime) });
    } catch (_) { /* optional media position display */ }
  }
}
function updatePlayButton() {
  nodes.playToggle.textContent = audio.paused ? '▶ 再生' : '❚❚ 一時停止';
  try {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState =
      (!audio.paused || (activeMemoAudio && !activeMemoAudio.paused)) ? 'playing' : 'paused';
  } catch (_) { /* optional platform integration */ }
}
function updateMemoPosition(voice) {
  if (activeMemoAudio !== voice || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  try {
    navigator.mediaSession.setPositionState(Number.isFinite(voice.duration) && voice.duration > 0 ? {
      duration: voice.duration, playbackRate: voice.playbackRate,
      position: Math.max(0, Math.min(voice.duration, voice.currentTime))
    } : {});
  } catch (_) { /* position is optional; some recorded containers have no duration */ }
}
function allowPlaybackAction() {
  if (state === 'idle') return true;
  stamp('録音・処理中の再生操作を拒否', { state });
  return false;
}
function pauseMemoPlayback() {
  for (const voice of nodes.memos.querySelectorAll('audio')) voice.pause();
  activeMemoAudio = null;
}
function setAudioMode(type) {
  try {
    if (navigator.audioSession) { navigator.audioSession.type = type; stamp('AudioSession設定要求', { type }); }
  } catch (err) { stamp('AudioSession設定不可', { name: err.name }); }
}
async function startPlay() {
  if (!allowPlaybackAction()) return false;
  const operation = ++playbackOperation;
  pauseMemoPlayback();
  updateMediaMetadata();
  setAudioMode('playback');
  try {
    await audio.play();
    if (operation !== playbackOperation) return false;
    if (state !== 'idle') { audio.pause(); return false; }
    stamp('再生開始', { at: Number(audio.currentTime.toFixed(2)) });
    setStatus('再生中。気づいたら「メモする」を押してね。');
    return true;
  } catch (err) {
    stamp('再生に失敗', { name: err.name, message: err.message });
    if (operation === playbackOperation && state === 'idle') setStatus('自動で再生できませんでした。「再生」をタップして再開してください。', true);
    return false;
  }
}
function stopTrack(url) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (url) URL.revokeObjectURL(url);
}
async function setTrack(file) {
  if (state !== 'idle') { setStatus('録音が終わってから音声を変更してください。', true); return; }
  playbackOperation++;
  setRecordState('loading');
  audio.pause();
  pauseMemoPlayback();
  let nextId = DEMO_ID;
  try {
    if (file) {
      if (file.size > MAX_FILE_BYTES) throw new Error('この検証版では50 MiB以下の音声を選んでください。');
      if (!crypto.subtle) throw new Error('音源を照合できない環境です。デモ音声で試してください。');
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      nextId = 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (err) {
    nodes.file.value = '';
    setRecordState('idle');
    setStatus(err.message, true);
    return;
  }
  stopTrack(userAudioUrl);
  userAudioUrl = null;
  if (file) {
    userAudioUrl = URL.createObjectURL(file);
    audio.src = userAudioUrl;
    trackLabel = file.name;
    trackKind = 'local-file';
    nodes.trackSubtitle.textContent = '選択ファイルはサーバーへ送信されません';
    stamp('音声ファイル選択', { type: file.type, bytes: file.size });
  } else {
    audio.src = DEMO_AUDIO;
    trackLabel = '操作検証用の英語音声（デモ）';
    trackKind = 'demo';
    nodes.trackSubtitle.textContent = '動作確認用の英語デモ音声';
    nodes.file.value = '';
    stamp('デモ音声へ切り替え');
  }
  nodes.trackName.textContent = trackLabel;
  trackId = nextId;
  audio.load();
  updateMediaMetadata();
  updatePlayButton();
  updatePlayback();
  setRecordState('idle');
  setStatus('音源を選びました。「再生」で試せます。');
}
function updateMediaMetadata() {
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: trackLabel, artist: 'Listen / Capture Spike' }); }
    catch (_) { /* metadata is optional */ }
  }
}
function chooseRecorderMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}
function setRecordState(next) {
  state = next;
  nodes.recordToggle.classList.toggle('recording', next === 'recording');
  if (next === 'idle') {
    nodes.recordLabel.textContent = 'メモを録音する';
    nodes.recordToggle.disabled = !canRecord() || !storageReady || audio.readyState < 1 || recoveryMemos.size >= 3;
  } else if (next === 'starting') {
    nodes.recordLabel.textContent = 'マイクを準備中…';
    nodes.recordToggle.disabled = true;
  } else if (next === 'recording') {
    nodes.recordLabel.textContent = '録音を終了する';
    nodes.recordToggle.disabled = false;
  } else if (next === 'saving') {
    nodes.recordLabel.textContent = 'メモを保存中…';
    nodes.recordToggle.disabled = true;
  } else {
    nodes.recordLabel.textContent = next === 'loading' ? '音声を確認中…' : '端末保存を確認中…';
    nodes.recordToggle.disabled = true;
  }
  const busy = next !== 'idle';
  for (const node of [nodes.playToggle, nodes.rewind, nodes.bookmark, nodes.file, nodes.useDemo, nodes.headsetTest]) node.disabled = busy;
  nodes.bookmark.disabled ||= !storageReady || audio.readyState < 1;
  nodes.seek.disabled = busy || !Number.isFinite(audio.duration) || audio.duration <= 0;
  nodes.recordToggle.setAttribute('aria-pressed', String(next === 'recording'));
  nodes.recordToggle.setAttribute('aria-busy', String(['starting','saving'].includes(next)));
  nodes.cancelStart.hidden = next !== 'starting';
  nodes.captureClock.hidden = !['recording','saving'].includes(next);
  for (const button of nodes.memos.querySelectorAll('button')) button.disabled = busy;
  for (const node of nodes.memos.querySelectorAll('a, audio')) node.inert = busy;
  for (const button of nodes.recovery.querySelectorAll('button')) button.disabled = busy;
}
function releaseMic(session = captureSession) {
  if (session?.stream) {
    session.stream.getTracks().forEach(track => track.stop());
    session.stream = null;
    if (captureSession === session) stream = null;
    stamp('マイク解放');
  }
  if (captureSession === session || !captureSession) setAudioMode('playback');
}
function clearCaptureTimers(session) {
  clearInterval(session.clock);
  clearTimeout(session.limit);
  clearTimeout(session.watchdog);
}
function cancelStarting() {
  if (state !== 'starting' || !captureSession) return;
  captureSession.cancelled = true;
  releaseMic(captureSession);
  captureSession = null;
  recorder = null;
  setRecordState('idle');
  setStatus('準備をキャンセルしました。表示中の許可画面はブラウザ側で閉じてください。');
  stamp('マイク準備をキャンセル');
}
async function beginRecording() {
  if (state !== 'idle' || !canRecord() || !storageReady || audio.readyState < 1 || recoveryMemos.size >= 3) return;
  playbackOperation++;
  // Snapshot before the permission prompt; asynchronous handlers use this session.
  const session = {
    id: id(), reference: { offsetSec: Math.max(0, audio.currentTime || 0), trackLabel, trackKind, trackId, createdAt: now() },
    resumeAfter: !audio.paused && !audio.ended, chunks: [], bytes: 0, stream: null,
    recorder: null, finalized: false, cancelled: false, stopRequested: false,
    interrupted: false, stopObserved: false, reason: 'user'
  };
  captureSession = session;
  captureReference = session.reference;
  wasPlayingBeforeRecording = session.resumeAfter;
  audio.pause();
  pauseMemoPlayback();
  stamp('録音開始要求／再生位置確定', { at: Number(session.reference.offsetSec.toFixed(2)) });
  setRecordState('starting');
  setStatus('マイクを準備しています。録音中の表示になってから話してください。');
  try {
    setAudioMode('play-and-record');
    const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (session.cancelled || captureSession !== session || document.hidden) {
      input.getTracks().forEach(track => track.stop());
      if (captureSession === session) cancelStarting();
      return;
    }
    stream = session.stream = input;
    const mimeType = chooseRecorderMime();
    recorder = session.recorder = mimeType ? new MediaRecorder(input, { mimeType }) : new MediaRecorder(input);
    chunks = session.chunks;
    recorder.addEventListener('dataavailable', (evt) => {
      if (!evt.data?.size || session.finalized) return;
      session.chunks.push(evt.data);
      session.bytes += evt.data.size;
      if (session.bytes >= MAX_RECORD_BYTES) requestStop(session, 'size-limit');
    });
    recorder.addEventListener('error', (evt) => {
      stamp('MediaRecorder error', { message: evt.error?.message || 'unknown' });
      requestStop(session, 'recorder-error');
    });
    recorder.addEventListener('stop', () => {
      session.stopObserved = true;
      void finalizeRecording(session);
    }, { once: true });
    for (const track of input.getAudioTracks()) {
      track.addEventListener('ended', () => requestStop(session, 'microphone-ended'), { once: true });
      track.addEventListener('mute', () => requestStop(session, 'microphone-muted'), { once: true });
    }
    recorder.start(1000);
    session.startedAt = performance.now();
    nodes.captureClock.textContent = '0:00 / 1:00';
    session.clock = setInterval(() => {
      nodes.captureClock.textContent = `${secTime((performance.now() - session.startedAt) / 1000)} / 1:00`;
    }, 500);
    session.limit = setTimeout(() => requestStop(session, 'time-limit'), MAX_RECORD_MS);
    setRecordState('recording');
    setStatus('録音中です。最大60秒。終了するとブラウザ内に保存します。');
    stamp('録音開始', { mimeType: recorder.mimeType || 'browser-default' });
  } catch (err) {
    releaseMic(session);
    if (captureSession !== session) return;
    captureSession = null;
    recorder = null;
    setRecordState('idle');
    setStatus(`録音を開始できませんでした（${err.name || 'Error'}）。マイク許可・HTTPS・イヤホン接続を確認してください。`, true);
    stamp('録音開始に失敗', { name: err.name, message: err.message });
  }
}
function requestStop(session, reason = 'user') {
  if (captureSession !== session || session.finalized || session.stopRequested) return;
  session.stopRequested = true;
  session.reason = reason;
  if (reason !== 'user') { session.interrupted = true; session.resumeAfter = false; }
  clearCaptureTimers(session);
  setRecordState('saving');
  setStatus('録音を終了して保存しています…');
  stamp('録音終了要求', { reason });
  try { if (session.recorder.state !== 'inactive') session.recorder.stop(); }
  catch (err) {
    session.interrupted = true;
    session.resumeAfter = false;
    stamp('録音終了に失敗', { name: err.name });
    releaseMic(session);
  }
  session.watchdog = setTimeout(() => {
    if (!session.finalized) {
      session.interrupted = true;
      session.resumeAfter = false;
      session.reason = 'stop-event-missing';
      void finalizeRecording(session);
    }
  }, 4000);
}
function endRecording() {
  if (state === 'recording' && captureSession) requestStop(captureSession);
}
function renderRecovery() {
  nodes.recovery.replaceChildren();
  nodes.recovery.hidden = recoveryMemos.size === 0;
  if (!recoveryMemos.size) return;
  const title = document.createElement('h3'); title.textContent = `未保存の録音が${recoveryMemos.size}件あります`;
  const hint = document.createElement('p'); hint.textContent = 'このページを閉じると失われます。保存を再試行するか、録音をダウンロードしてください。';
  nodes.recovery.append(title, hint);
  for (const [memoId, entry] of recoveryMemos) {
    const row = document.createElement('div'); row.className = 'recovery-actions';
    const label = document.createElement('span'); label.textContent = `${secTime(entry.memo.offsetSec)} の録音`;
    const download = document.createElement('a'); download.textContent = '未保存の録音をダウンロード';
    download.href = entry.url; download.download = `unsaved-recording-${memoId}.${extensionFor(entry.memo.mimeType)}`;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '保存を再試行'; retry.dataset.action = 'retry';
    retry.addEventListener('click', async () => {
      if (state !== 'idle') return;
      setRecordState('saving');
      let persisted = false;
      try {
        await putMemo(entry.memo); persisted = true;
        recoveryMemos.delete(memoId); URL.revokeObjectURL(entry.url); renderRecovery();
        stamp('未保存録音の再保存に成功');
      } catch (err) { stamp('未保存録音の再保存に失敗', { name: err.name }); }
      finally { setRecordState('idle'); }
      if (!persisted) { setStatus('まだ保存できません。救済用のダウンロードは引き続き利用できます。', true); return; }
      try { await renderMemos(); setStatus('録音をこのブラウザ内に保存しました。'); }
      catch (_) { setStatus('録音は保存済みですが、一覧を更新できません。再読み込みで確認してください。', true); }
    });
    const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = '未保存データを破棄';
    discard.addEventListener('click', () => {
      if (state !== 'idle' || !confirm('この録音を破棄しますか？必要な録音は先にダウンロードしてください。')) return;
      recoveryMemos.delete(memoId); URL.revokeObjectURL(entry.url); renderRecovery(); setRecordState('idle');
      stamp('未保存録音を手動で破棄');
    });
    row.append(label, download, retry, discard); nodes.recovery.append(row);
  }
  setRecordState(state);
}
async function finalizeRecording(session = captureSession) {
  if (!session || session.finalized) return;
  session.finalized = true;
  if (!session.stopRequested) { session.interrupted = true; session.resumeAfter = false; session.reason = 'unexpected-stop'; }
  clearCaptureTimers(session);
  if (captureSession === session) setRecordState('saving');
  releaseMic(session);
  const actualMime = session.recorder?.mimeType || session.chunks[0]?.type || 'application/octet-stream';
  const blob = new Blob(session.chunks, { type: actualMime });
  session.chunks = [];
  const memo = {
    id: session.id, kind: 'voice', ...session.reference, mimeType: actualMime, blob,
    bytes: blob.size, savedAt: now(), interrupted: session.interrupted,
    stopReason: session.reason, incomplete: !session.stopObserved
  };
  let didPersist = false;
  let rendered = true;
  if (blob.size) {
    try {
      await putMemo(memo);
      didPersist = true;
      stamp('録音を端末内に保存', { size: blob.size, mime: actualMime, at: Number(memo.offsetSec.toFixed(2)), interrupted: memo.interrupted });
    } catch (err) {
      recoveryMemos.set(memo.id, { memo, url: URL.createObjectURL(blob) }); renderRecovery();
      stamp('保存に失敗／録音を救済領域に保持', { name: err.name, message: err.message });
    }
    if (didPersist) {
      try { await renderMemos(); }
      catch (err) { rendered = false; stamp('保存済み／一覧更新に失敗', { message: err.message }); }
    }
  } else stamp('録音データが空／保存不可', { reason: session.reason });
  if (captureSession === session) {
    captureSession = null; recorder = null; chunks = []; stream = null;
    captureReference = null; wasPlayingBeforeRecording = false;
    setRecordState('idle');
  }
  if (!blob.size) { setStatus('録音データを取得できませんでした。もう一度録音してください。', true); return; }
  if (!didPersist) { setStatus('ブラウザ保存に失敗しました。下の「未保存の録音」から救済できます。', true); return; }
  let resumed = false;
  if (session.resumeAfter && !document.hidden) {
    audio.currentTime = session.reference.offsetSec;
    updatePlayback();
    resumed = await startPlay();
  }
  if (state !== 'idle' || captureSession) return;
  if (!rendered) setStatus('録音は保存済みですが、一覧を更新できません。再読み込みで確認してください。', true);
  else if (memo.interrupted) setStatus('中断時に取得できた録音を保存しました。内容を確認してから再生を再開してください。', true);
  else if (session.resumeAfter && !resumed) setStatus('音声メモは保存しました。「再生」をタップして元の音声へ戻ってください。', true);
  else setStatus(resumed ? '音声メモを保存しました。元の位置から再生中です。' : '音声メモをこのブラウザ内に保存しました。');
}
async function saveBookmark(source='button') {
  if (state !== 'idle' || !storageReady || audio.readyState < 1 || !Number.isFinite(audio.currentTime)) return;
  const offsetSec = Math.max(0, audio.currentTime - 2);
  try {
    await putMemo({id:id(),kind:'bookmark',createdAt:now(),savedAt:now(),offsetSec,trackLabel,trackKind,trackId,source});
    stamp('印を保存', { from: source, at: Number(offsetSec.toFixed(2)) });
    setStatus('気になった位置の2秒手前に印を残しました。');
  } catch (err) {setStatus('印の保存に失敗しました。', true);stamp('印の保存エラー',{message:err.message});return;}
  try { await renderMemos(); }
  catch (_) { setStatus('印は保存済みですが、一覧を更新できません。再読み込みで確認してください。', true); }
}
async function renderMemos() {
  const revision = ++renderRevision;
  const data = (await getMemos()).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  if (revision !== renderRevision) return;
  pauseMemoPlayback();
  for (const url of memoObjectUrls) URL.revokeObjectURL(url);
  memoObjectUrls.length = 0;
  nodes.memos.replaceChildren();
  if (!data.length) { const p=document.createElement('p'); p.className='empty'; p.textContent='まだメモはありません。'; nodes.memos.append(p); return; }
  for (const memo of data) {
    const row = document.createElement('article'); row.className='memo'; row.dataset.memoId=memo.id;
    const head = document.createElement('div'); head.className='memo-head';
    const at = document.createElement('span'); at.className='memo-time'; at.textContent=`${secTime(memo.offsetSec)} の${memo.kind==='voice'?'音声メモ':'印'}${memo.interrupted?'（中断あり）':''}`;
    const date = document.createElement('span'); date.className='memo-kind'; date.textContent = new Date(memo.createdAt).toLocaleString('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    head.append(at,date); row.append(head);
    const meta=document.createElement('p');meta.className='memo-meta';meta.textContent=memo.trackLabel || '音源名なし';row.append(meta);
    if (memo.kind === 'voice' && memo.blob) {
      const voice = document.createElement('audio'); voice.controls=true; voice.preload='none';
      const url=URL.createObjectURL(memo.blob);memoObjectUrls.push(url);voice.src=url;row.append(voice);
      voice.setAttribute('aria-label',`${secTime(memo.offsetSec)} の録音を再生`);
      voice.addEventListener('play',()=>{
        if(state!=='idle'){voice.pause();return;}
        audio.pause();
        for(const other of nodes.memos.querySelectorAll('audio'))if(other!==voice)other.pause();
        activeMemoAudio=voice;
        try {if('mediaSession' in navigator && 'MediaMetadata' in window)navigator.mediaSession.metadata=new MediaMetadata({title:`${secTime(memo.offsetSec)} の音声メモ`,artist:'Listen / Capture Spike'});}catch(_){}
        updatePlayButton();updateMemoPosition(voice);stamp('保存メモの再生');
      });
      voice.addEventListener('pause',updatePlayButton);
      voice.addEventListener('timeupdate',()=>updateMemoPosition(voice));
      voice.addEventListener('loadedmetadata',()=>updateMemoPosition(voice));
      voice.addEventListener('ended',()=>{if(activeMemoAudio!==voice)return;activeMemoAudio=null;updateMediaMetadata();updatePlayButton();updatePlayback();});
      voice.addEventListener('error',()=>{setStatus('録音を再生できません。ファイルとして保存し、内容を確認してください。',true);stamp('保存メモの再生エラー');});
    }
    const actions=document.createElement('div');actions.className='memo-actions';
    const seek=document.createElement('button');seek.type='button';seek.textContent='元の位置へ戻る';
    seek.addEventListener('click',()=>{
      if(!allowPlaybackAction())return;
      if(!memo.trackId || memo.trackId !== trackId){
        setStatus('録音元の音声ファイルを先に選び直してください。同じ名前でも内容が異なる音源には戻れません。',true);return;
      }
      if(audio.readyState === 0) {setStatus('音声を読み込んでからお試しください。',true);return;}
      pauseMemoPlayback();audio.pause();audio.currentTime = memo.offsetSec; updateMediaMetadata();updatePlayback();
      stamp('元の位置へ戻る',{at:Number(memo.offsetSec.toFixed(2))});
      setStatus('元の位置へ移動しました。「再生」を押すと続きから聴けます。');
      window.scrollTo({top:0,behavior:'smooth'});
    });actions.append(seek);
    if(memo.kind==='voice' && memo.blob){
      const download=document.createElement('a');download.textContent='録音を保存';
      download.href=memoObjectUrls[memoObjectUrls.length-1];
      download.download=`voice-memo-${memo.createdAt.replace(/[:.]/g,'-')}.${extensionFor(memo.mimeType)}`;
      actions.append(download);
    }
    const remove=document.createElement('button');remove.type='button';remove.className='delete';remove.textContent='削除';
    remove.addEventListener('click',async()=>{
      if(state!=='idle')return;
      if(!window.confirm('このメモを削除しますか？')) return;
      try{await deleteMemo(memo.id);stamp('メモを削除',{kind:memo.kind});await renderMemos();}
      catch(err){setStatus(`削除できませんでした: ${err.message}`,true);}
    });actions.append(remove);
    row.append(actions);nodes.memos.append(row);
  }
  setRecordState(state);
}
function installMediaSession() {
  if (!('mediaSession' in navigator)) {stamp('Media Session非対応');return;}
  const remoteSeek=(seconds,relative=true)=>{
    if(!allowPlaybackAction() || !Number.isFinite(seconds))return;
    const target=activeMemoAudio || audio;
    if(target.readyState<1)return;
    const position=(relative?target.currentTime:0)+seconds;
    target.currentTime=Math.max(0,Math.min(Number.isFinite(target.duration)?target.duration:position,position));
    updatePlayback();
  };
  const handlers = {
    play: async()=>{
      stamp('MediaSession: play');if(!allowPlaybackAction())return;
      if(activeMemoAudio){try{await activeMemoAudio.play();}catch(_){if(state==='idle')setStatus('録音の再生ボタンをタップしてください。',true);}}
      else await startPlay();
    },
    pause: ()=>{stamp('MediaSession: pause');(activeMemoAudio || audio).pause();},
    seekbackward: (evt)=>{stamp('MediaSession: seekbackward');remoteSeek(-(evt.seekOffset||10));},
    seekforward: (evt)=>{stamp('MediaSession: seekforward');remoteSeek(evt.seekOffset||10);},
    seekto:(evt)=>{stamp('MediaSession: seekto');remoteSeek(evt.seekTime,false);},
    previoustrack:()=>{stamp('MediaSession: previoustrack');remoteSeek(-10);},
    nexttrack:()=>{stamp('MediaSession: nexttrack');if(nodes.headsetTest.checked && !activeMemoAudio)void saveBookmark('media-nexttrack');}
  };
  for(const [name,callback] of Object.entries(handlers)){
    try {navigator.mediaSession.setActionHandler(name, callback);stamp(`MediaSession handler registered: ${name}`);}
    catch(err){stamp(`MediaSession handler unavailable: ${name}`,{name:err.name});}
  }
  updateMediaMetadata();
}
function renderFeatures() {
  const list = [
    ['セキュアな接続',window.isSecureContext?'はい':'いいえ（HTTPS / localhostが必要）'],
    ['マイクAPI',navigator.mediaDevices?.getUserMedia?'利用可':'利用不可'],
    ['MediaRecorder',window.MediaRecorder?'利用可':'利用不可'],
    ['端末保存',storageReady?'IndexedDB 準備完了':'未確認 / 利用不可'],
    ['Media Session',('mediaSession' in navigator)?'利用可（操作は別途検証）':'利用不可'],
    ['Audio Session',navigator.audioSession?'利用可（経路は実機検証）':'利用不可'],
    ['ページ状態',document.visibilityState],
    ['ブラウザ',navigator.userAgent]
  ];
  nodes.features.replaceChildren();
  for(const [label,value] of list){const div=document.createElement('div');const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;div.append(dt,dd);nodes.features.append(div);}
}
function attachEvents() {
  nodes.playToggle.addEventListener('click',()=>{if(!allowPlaybackAction())return;if(audio.paused)void startPlay();else audio.pause();});
  nodes.rewind.addEventListener('click',()=>{if(!allowPlaybackAction())return;pauseMemoPlayback();audio.currentTime=Math.max(0,audio.currentTime-10);updatePlayback();stamp('10秒戻る');});
  nodes.bookmark.addEventListener('click',()=>void saveBookmark());
  nodes.recordToggle.addEventListener('click',()=>{if(state==='idle')void beginRecording();else if(state==='recording')endRecording();});
  nodes.cancelStart.addEventListener('click',cancelStarting);
  nodes.file.addEventListener('change',()=>{if(nodes.file.files?.[0])void setTrack(nodes.file.files[0]);});
  nodes.useDemo.addEventListener('click',()=>void setTrack(null));
  nodes.seek.addEventListener('input',()=>{if(!allowPlaybackAction())return;isSeeking=true;nodes.currentTime.textContent=secTime((Number(nodes.seek.value)/1000)*(audio.duration||0));});
  nodes.seek.addEventListener('change',()=>{if(!allowPlaybackAction())return;pauseMemoPlayback();audio.currentTime=(Number(nodes.seek.value)/1000)*(audio.duration||0);isSeeking=false;updatePlayback();stamp('再生位置を変更',{at:Number(audio.currentTime.toFixed(2))});});
  audio.addEventListener('loadedmetadata',()=>{updatePlayback();setRecordState(state);stamp('音声読み込み完了',{seconds:Number((audio.duration||0).toFixed(2))});});
  audio.addEventListener('timeupdate',updatePlayback);
  audio.addEventListener('play',()=>{if(state!=='idle')audio.pause();updatePlayButton();});
  audio.addEventListener('pause',updatePlayButton);
  audio.addEventListener('ended',()=>{updatePlayButton();stamp('再生終了');});
  audio.addEventListener('error',()=>{stamp('音声再生エラー',{code:audio.error?.code||'unknown'});setStatus('音声が読み込めません。別のファイルを試してください。',true);});
  document.addEventListener('visibilitychange',()=>{
    stamp('ページ可視状態変更',{visibility:document.visibilityState});
    if(document.hidden && state==='starting')cancelStarting();
    else if(document.hidden && state==='recording' && captureSession)requestStop(captureSession,'page-hidden');
    renderFeatures();
  });
  window.addEventListener('pagehide',()=>{
    stamp('pagehide');
    if(state==='starting')cancelStarting();
    else if(state==='recording' && captureSession)requestStop(captureSession,'pagehide');
  });
  window.addEventListener('beforeunload',(event)=>{if(captureSession || recoveryMemos.size){event.preventDefault();event.returnValue='';}});
  nodes.headsetTest.addEventListener('change',()=>stamp('イヤホンnexttrack試験の設定',{enabled:nodes.headsetTest.checked}));
  nodes.exportLog.addEventListener('click',()=>{
    const payload={version:'0.2',generatedAt:now(),userAgent:navigator.userAgent,secureContext:window.isSecureContext,events:logEntries};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`audio-spike-log-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  });
}
async function boot() {
  attachEvents();
  renderFeatures();
  installMediaSession();
  updatePlayButton();
  setRecordState('booting');
  try{
    await renderMemos();storageReady=true;stamp('IndexedDBの準備完了');
    setStatus(canRecord()?'準備完了。「再生」から試してみよう。':'録音APIを使えません。HTTPS上で開いているか確認してください。',!canRecord());
  }
  catch(err){stamp('IndexedDB初期化に失敗',{message:err.message});setStatus('端末保存を利用できません。通常モードのSafariで試してください。',true);}
  setRecordState('idle');renderFeatures();
  stamp('起動',{secureContext:window.isSecureContext,microphone:canRecord()});
}
void boot();
