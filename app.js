/* Audio Technical Spike v0.1 - no backend, no frameworks, no network requests.
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
  headsetTest: $('headsetTest')
};
const DB_NAME = 'listen-capture-spike-v1';
const STORE = 'memos';
const logEntries = [];
const memoObjectUrls = [];
const DEMO_AUDIO = './assets/sample.mp3';
let userAudioUrl = null;
let trackLabel = '操作検証用の英語音声（デモ）';
let trackKind = 'demo';
let dbPromise = null;
let recorder = null;
let stream = null;
let chunks = [];
let captureReference = null;
let wasPlayingBeforeRecording = false;
let state = 'idle'; // idle | starting | recording | saving
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
      req.onsuccess = () => resolve(req.result);
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
  if (!isSeeking) nodes.seek.value = duration ? Math.floor(1000 * audio.currentTime / duration) : '0';
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    try {
      if (duration > 0) navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate, position: Math.min(duration, audio.currentTime) });
    } catch (_) { /* optional media position display */ }
  }
}
function updatePlayButton() {
  nodes.playToggle.textContent = audio.paused ? '▶ 再生' : '❚❚ 一時停止';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
async function startPlay() {
  try {
    await audio.play();
    stamp('再生開始', { at: Number(audio.currentTime.toFixed(2)) });
    setStatus('再生中。気づいたら「メモする」を押してね。');
  } catch (err) {
    stamp('再生に失敗', { name: err.name, message: err.message });
    setStatus('自動で再生できませんでした。「再生」をタップして再開してください。', true);
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
  audio.load();
  updateMediaMetadata();
  updatePlayButton();
  updatePlayback();
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
    nodes.recordLabel.textContent = '● メモを録音する';
    nodes.recordToggle.disabled = !canRecord();
  } else if (next === 'starting') {
    nodes.recordLabel.textContent = 'マイクを準備中…';
    nodes.recordToggle.disabled = true;
  } else if (next === 'recording') {
    nodes.recordLabel.textContent = '■ 録音を終了する';
    nodes.recordToggle.disabled = false;
  } else {
    nodes.recordLabel.textContent = 'メモを保存中…';
    nodes.recordToggle.disabled = true;
  }
}
function releaseMic() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
    stamp('マイク解放');
  }
}
async function beginRecording() {
  if (state !== 'idle' || !canRecord()) return;
  // Must fix the source reference BEFORE awaiting the microphone permission UI.
  wasPlayingBeforeRecording = !audio.paused;
  captureReference = { offsetSec: Math.max(0, audio.currentTime || 0), trackLabel, trackKind, createdAt: now() };
  audio.pause();
  stamp('録音開始要求／再生位置確定', { at: Number(captureReference.offsetSec.toFixed(2)) });
  setRecordState('starting');
  setStatus('マイクの利用許可を確認中です…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = chooseRecorderMime();
    chunks = [];
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (evt) => { if (evt.data?.size) chunks.push(evt.data); });
    recorder.addEventListener('error', (evt) => {
      stamp('MediaRecorder error', { message: evt.error?.message || 'unknown' });
      setStatus('録音エラーが発生しました。録音を終了してください。', true);
    });
    recorder.addEventListener('stop', () => { void finalizeRecording(); }, { once: true });
    recorder.start(1000);
    setRecordState('recording');
    setStatus('録音中です。終了するとブラウザ内に保存します。');
    stamp('録音開始', { mimeType: recorder.mimeType || 'browser-default' });
  } catch (err) {
    releaseMic();
    recorder = null;
    setRecordState('idle');
    setStatus(`録音を開始できませんでした（${err.name || 'Error'}）。マイク許可・HTTPS・イヤホン接続を確認してください。`, true);
    stamp('録音開始に失敗', { name: err.name, message: err.message });
    // Do NOT force resume after permission denied: a user gesture may be required.
  }
}
function endRecording() {
  if (state !== 'recording' || !recorder) return;
  setRecordState('saving');
  setStatus('録音を終了して保存しています…');
  try { recorder.stop(); } catch (err) {
    stamp('録音終了に失敗', { name: err.name, message: err.message });
    releaseMic();
    setRecordState('idle');
    setStatus('録音終了に失敗しました。', true);
  }
}
async function finalizeRecording() {
  releaseMic();
  let didPersist = false;
  try {
    const actualMime = (chunks[0]?.type || recorder?.mimeType || 'application/octet-stream').split(';')[0];
    const blob = new Blob(chunks, { type: actualMime });
    if (!blob.size) throw new Error('空の録音です');
    const memo = {
      id: id(), kind: 'voice', ...captureReference,
      mimeType: actualMime, blob, bytes: blob.size, savedAt: now()
    };
    await putMemo(memo);
    didPersist = true;
    stamp('録音を端末内に保存', { size: blob.size, mime: actualMime, at: Number(memo.offsetSec.toFixed(2)) });
    setStatus('音声メモを保存しました。この端末内のみの保存です。');
    await renderMemos();
  } catch (err) {
    // If disk writes fail, make raw audio available for export while the page remains open.
    const fallbackBlob = new Blob(chunks, { type: chunks[0]?.type || recorder?.mimeType || 'application/octet-stream' });
    if (fallbackBlob.size) {
      const url = URL.createObjectURL(fallbackBlob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `unsaved-recording.${extensionFor(fallbackBlob.type)}`;
      anchor.textContent = '保存できなかった録音をダウンロード';
      anchor.className = 'fallback-link';
      nodes.status.replaceChildren(document.createTextNode('ブラウザ保存に失敗しました。 '), anchor);
      nodes.status.classList.add('warning');
      stamp('保存に失敗／手動救済リンクを表示', { name: err.name, message: err.message });
    } else {
      setStatus('録音データを作成できませんでした。', true);
      stamp('録音データが空／保存不可', { message: err.message });
    }
  } finally {
    chunks = [];
    recorder = null;
    captureReference = null;
    setRecordState('idle');
    if (wasPlayingBeforeRecording && didPersist) {
      wasPlayingBeforeRecording = false;
      // Browsers may reject this after a microphone permission dialog / async save.
      await startPlay();
    } else {
      wasPlayingBeforeRecording = false;
    }
  }
}
async function saveBookmark(source='button') {
  if (state !== 'idle' || !Number.isFinite(audio.currentTime)) return;
  const offsetSec = Math.max(0, audio.currentTime - 2);
  try {
    await putMemo({id:id(),kind:'bookmark',createdAt:now(),savedAt:now(),offsetSec,trackLabel,trackKind,source});
    stamp('印を保存', { from: source, at: Number(offsetSec.toFixed(2)) });
    setStatus('気になった位置に印を残しました。');
    await renderMemos();
  } catch (err) {setStatus('印の保存に失敗しました。', true);stamp('印の保存エラー',{message:err.message});}
}
async function renderMemos() {
  for (const url of memoObjectUrls) URL.revokeObjectURL(url);
  memoObjectUrls.length = 0;
  const data = (await getMemos()).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  nodes.memos.replaceChildren();
  if (!data.length) { const p=document.createElement('p'); p.className='empty'; p.textContent='まだメモはありません。'; nodes.memos.append(p); return; }
  for (const memo of data) {
    const row = document.createElement('article'); row.className='memo';
    const head = document.createElement('div'); head.className='memo-head';
    const at = document.createElement('span'); at.className='memo-time'; at.textContent=`${secTime(memo.offsetSec)} の${memo.kind==='voice'?'音声メモ':'印'}`;
    const date = document.createElement('span'); date.className='memo-kind'; date.textContent = new Date(memo.createdAt).toLocaleString('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    head.append(at,date); row.append(head);
    const meta=document.createElement('p');meta.className='memo-meta';meta.textContent=memo.trackLabel || '音源名なし';row.append(meta);
    if (memo.kind === 'voice' && memo.blob) {
      const voice = document.createElement('audio'); voice.controls=true; voice.preload='none';
      const url=URL.createObjectURL(memo.blob);memoObjectUrls.push(url);voice.src=url;row.append(voice);
    }
    const actions=document.createElement('div');actions.className='memo-actions';
    const seek=document.createElement('button');seek.type='button';seek.textContent='元の位置へ戻る';
    seek.addEventListener('click',()=>{
      if(memo.trackKind !== trackKind || memo.trackLabel !== trackLabel){
        setStatus('録音元の音声ファイルを先に選び直してください。元ファイルはこの試作では保存されません。',true);return;
      }
      if(audio.readyState === 0) {setStatus('音声を読み込んでからお試しください。',true);return;}
      audio.currentTime = memo.offsetSec; updatePlayback();
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
      if(!window.confirm('このメモを削除しますか？')) return;
      try{await deleteMemo(memo.id);stamp('メモを削除',{kind:memo.kind});await renderMemos();}
      catch(err){setStatus(`削除できませんでした: ${err.message}`,true);}
    });actions.append(remove);
    row.append(actions);nodes.memos.append(row);
  }
}
function installMediaSession() {
  if (!('mediaSession' in navigator)) {stamp('Media Session非対応');return;}
  const handlers = {
    play: ()=>{stamp('MediaSession: play');void startPlay();},
    pause: ()=>{stamp('MediaSession: pause');audio.pause();},
    seekbackward: (evt)=>{stamp('MediaSession: seekbackward');audio.currentTime=Math.max(0,audio.currentTime-(evt.seekOffset||10));},
    seekforward: (evt)=>{stamp('MediaSession: seekforward');audio.currentTime=Math.min(audio.duration||audio.currentTime+10,audio.currentTime+(evt.seekOffset||10));},
    previoustrack:()=>{stamp('MediaSession: previoustrack');audio.currentTime=Math.max(0,audio.currentTime-10);},
    nexttrack:()=>{stamp('MediaSession: nexttrack');if(nodes.headsetTest.checked)void saveBookmark('media-nexttrack');}
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
    ['IndexedDB',('indexedDB' in window)?'利用可':'利用不可'],
    ['Media Session',('mediaSession' in navigator)?'利用可（操作は別途検証）':'利用不可'],
    ['ページ状態',document.visibilityState],
    ['ブラウザ',navigator.userAgent]
  ];
  nodes.features.replaceChildren();
  for(const [label,value] of list){const div=document.createElement('div');const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;div.append(dt,dd);nodes.features.append(div);}
}
function attachEvents() {
  nodes.playToggle.addEventListener('click',()=>{if(audio.paused)void startPlay();else audio.pause();});
  nodes.rewind.addEventListener('click',()=>{audio.currentTime=Math.max(0,audio.currentTime-10);stamp('10秒戻る');});
  nodes.bookmark.addEventListener('click',()=>void saveBookmark());
  nodes.recordToggle.addEventListener('click',()=>{if(state==='idle')void beginRecording();else if(state==='recording')endRecording();});
  nodes.file.addEventListener('change',()=>{if(nodes.file.files?.[0])void setTrack(nodes.file.files[0]);});
  nodes.useDemo.addEventListener('click',()=>void setTrack(null));
  nodes.seek.addEventListener('input',()=>{isSeeking=true;nodes.currentTime.textContent=secTime((Number(nodes.seek.value)/1000)*(audio.duration||0));});
  nodes.seek.addEventListener('change',()=>{audio.currentTime=(Number(nodes.seek.value)/1000)*(audio.duration||0);isSeeking=false;updatePlayback();stamp('再生位置を変更',{at:Number(audio.currentTime.toFixed(2))});});
  audio.addEventListener('loadedmetadata',()=>{updatePlayback();stamp('音声読み込み完了',{seconds:Number((audio.duration||0).toFixed(2))});});
  audio.addEventListener('timeupdate',updatePlayback);
  audio.addEventListener('play',updatePlayButton);
  audio.addEventListener('pause',updatePlayButton);
  audio.addEventListener('ended',()=>{updatePlayButton();stamp('再生終了');});
  audio.addEventListener('error',()=>{stamp('音声再生エラー',{code:audio.error?.code||'unknown'});setStatus('音声が読み込めません。別のファイルを試してください。',true);});
  document.addEventListener('visibilitychange',()=>{stamp('ページ可視状態変更',{visibility:document.visibilityState});renderFeatures();});
  window.addEventListener('pagehide',()=>stamp('pagehide'));
  nodes.headsetTest.addEventListener('change',()=>stamp('イヤホンnexttrack試験の設定',{enabled:nodes.headsetTest.checked}));
  nodes.exportLog.addEventListener('click',()=>{
    const payload={generatedAt:now(),userAgent:navigator.userAgent,secureContext:window.isSecureContext,events:logEntries};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`audio-spike-log-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
  });
}
async function boot() {
  attachEvents();
  renderFeatures();
  installMediaSession();
  updatePlayButton();
  setRecordState('idle');
  if(!canRecord())setStatus('録音APIを使えません。HTTPS上で開いているか確認してください。',true);
  else setStatus('準備完了。「再生」から試してみよう。');
  try{await renderMemos();stamp('IndexedDBの準備完了');}
  catch(err){stamp('IndexedDB初期化に失敗',{message:err.message});setStatus('端末保存を利用できません。通常モードのSafariで試してください。',true);nodes.recordToggle.disabled=true;}
  stamp('起動',{secureContext:window.isSecureContext,microphone:canRecord()});
}
void boot();
