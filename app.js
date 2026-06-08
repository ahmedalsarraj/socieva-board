// ========== CONFIG ==========
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDNef6o6VhoaPf5Og2fmxwgRTRh7ydNmuc',
  authDomain: 'content-board-capital.firebaseapp.com',
  projectId: 'content-board-capital',
  storageBucket: 'content-board-capital.firebasestorage.app',
  messagingSenderId: '459037063501',
  appId: '1:459037063501:web:03ccaf4edb89cf3ab31f04',
  measurementId: 'G-2GYX7Y5M2T'
};

const SESSION_KEY = 'sb_session_v2';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FIREBASE_BOARD_CACHE_PREFIX = 'sb_firebase_board_cache_';

// ========== DEBOUNCE ==========
function debounce(fn,delay=200){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),delay);};}

// Concurrency limiter — max 5 parallel Firebase requests
async function mapLimit(arr, limit, fn){
  const results=[];
  let i=0;
  async function next(){
    const idx=i++;
    if(idx>=arr.length)return;
    results[idx]=await fn(arr[idx],idx);
    await next();
  }
  await Promise.all(Array.from({length:Math.min(limit,arr.length)},next));
  return results;
}

// ========== STATE ==========
let currentSession = null;
let pendingChangePwSession = null;
let boardUsers = [];
let cards = [];
let editId = null;
let carouselImages = []; // [{shareUrl,itemId,downloadUrl}] for carousel multi-image
let thumbFileUrl = null;
let vidFileUrl = null;
let thumbItemId = null;
let vidItemId = null;
let thumbDisplayUrl = null;
let vidDisplayUrl = null;
let boardSettings = null;
let settingsDraft = null;
let dragCardId = null;
let pendingDelete = null;
let boardSnapshotSeq = 0; // incremented after a committed delete to discard in-flight stale snapshot callbacks
let expandedStages = new Set();
let activeFilters = {q:'',format:'',stage:'',category:'',priority:'',compliance:'',presenter:'',assign:'',editor:'',postDateFrom:'',postDateTo:'',dueDateFrom:'',dueDateTo:'',channel:'',segment:'',hasThumb:false,hasVid:false,overdue:false,dueSoon:false};
let sortBy = 'priority';
let sortDir = 'asc';
let filterPanelOpen = false;
let boardMode = 'videos'; // 'videos' | 'carousels'
let carouselCards = [];
let carouselLoaded = false;
let transferGen = 0; // incremented on every resetModal() to cancel stale async callbacks
let activeUploadPromises = new Set(); // all in-flight modal uploads; save waits for every one
let modalUploadedItems = new Set(); // files uploaded in the current modal session, deleted on cancel if unsaved
let pendingFileDeletes = new Set(); // existing files to delete only after a successful save
let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseStorage = null;
let firebaseFunctions = null;
let boardSnapshotUnsub = null;
let boardSnapshotMode = null;
let pendingSnapshotPayload = null;
let boardRevision = 0;
let cardBaselineData = new Map();
let cardBaselineRev = new Map();
let settingsBaselineJson = '';

// ========== CONSTANTS ==========
const STAGES          = ['Script','Recording','Under editing','Ready to post','Posted'];
const CAROUSEL_STAGES = ['Script','Working on','Ready to post','Posted'];
function currentStages(){ return boardMode==='carousels'?CAROUSEL_STAGES:STAGES; }
const DEFAULT_CATEGORIES = ['Education','Market','Motivation','Challenge','Funny','Branding','Story','Top XXX','General'];
const ROLE_DEFS = [
  {key:'presenter',label:'Presenter'},
  {key:'assigned',label:'Assigned'},
  {key:'editor',label:'Editor'},
  {key:'approver',label:'Approver'}
];
const CAT_TAG = {Education:'tag-edu',Market:'tag-mkt',Motivation:'tag-mot',Funny:'tag-fun','Top XXX':'tag-top',Branding:'tag-brd',Challenge:'tag-chl',General:'tag-gen',Story:'tag-str'};
const AV_COLORS = {};
const PRI_COLORS = {High:'#f87171',Medium:'#e8a83b',Low:'#5ae8a0'};
const PRI_ORDER = {High:0,Medium:1,Low:2};
const CARD_COLLAPSE_LIMIT = 3;

// ========== UTILITIES ==========
function initials(n){if(!n)return'?';const p=n.trim().split(' ');return p.length>1?(p[0][0]+p[p.length-1][0]).toUpperCase():n.slice(0,2).toUpperCase()}
function parseLocalDate(value){
  if(!value)return null;
  const m=String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  const d=new Date(value);
  return Number.isNaN(d.getTime())?null:d;
}
function localDateKey(value){
  const d=parseLocalDate(value);
  if(!d)return'';
  const pad=n=>String(n).padStart(2,'0');
  return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function dateTimeKey(value){
  const d=parseLocalDate(value);
  return d?d.getTime():'';
}
function fmtDate(d){const key=localDateKey(d);if(!key)return'';const p=key.split('-');const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${parseInt(p[2],10)} ${m[parseInt(p[1],10)-1]||''}`}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function escHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function safeUrl(u){if(!u)return'';const s=String(u).trim();return(s.startsWith('https://')||s.startsWith('http://')||s.startsWith('blob:')||s.startsWith('data:image/')||s.startsWith('data:video/'))?s:''}
function jsArg(s){return escHtml(JSON.stringify(String(s??'')))}
function norm(s){return String(s||'').trim().toLowerCase()}

// ========== FIREBASE BACKEND ==========
function initFirebaseBackend(){
  if(firebaseApp)return;
  if(typeof firebase === 'undefined')throw new Error('Firebase SDK failed to load.');
  firebaseApp=firebase.initializeApp(FIREBASE_CONFIG);
  firebaseAuth=firebase.auth();
  firebaseDb=firebase.firestore();
  firebaseStorage=firebase.storage();
  firebaseFunctions=typeof firebase.functions === 'function' ? firebase.app().functions('us-central1') : null;
}

function firebaseBoardDoc(){return boardMode==='carousels'?'carousels':'videos'}
function firebaseBoardRef(mode=boardMode){return firebaseDb.collection('board').doc(mode==='carousels'?'carousels':'videos')}
function firebaseCardsRef(mode=boardMode){return firebaseBoardRef(mode).collection('cards')}
function firebaseBoardCacheKey(mode=boardMode){return FIREBASE_BOARD_CACHE_PREFIX+mode}
function cleanCardForStorage(card){
  const out=JSON.parse(JSON.stringify(card||{}));
  delete out._rev;
  delete out.thumbDisplayUrl;
  delete out.vidDisplayUrl;
  if(Array.isArray(out.images)){
    out.images=out.images.map(img=>{
      const clean={...img};
      delete clean.downloadUrl;
      return clean;
    });
  }
  return out;
}
function cardFromDoc(doc){
  const data=doc.data()||{};
  return{id:doc.id,...data,_rev:Number(data._rev||0)};
}
function cardsFromSnapshot(snap){
  const list=snap.docs.map(cardFromDoc);
  if(list.some(card=>Number.isFinite(card.sortIndex))){
    return list.sort((a,b)=>(Number.isFinite(a.sortIndex)?a.sortIndex:Number.MAX_SAFE_INTEGER)-(Number.isFinite(b.sortIndex)?b.sortIndex:Number.MAX_SAFE_INTEGER));
  }
  return list;
}
function cardBaselineJson(card){return JSON.stringify(cleanCardForStorage(card));}
function setCardBaselines(list){
  cardBaselineData=new Map();
  cardBaselineRev=new Map();
  (list||[]).forEach(card=>{
    if(!card?.id)return;
    cardBaselineData.set(card.id,cardBaselineJson(card));
    cardBaselineRev.set(card.id,Number(card._rev||0));
  });
}
function setSettingsBaseline(){
  settingsBaselineJson=JSON.stringify(normalizeSettings(getSettings()));
}
function applyBoardPayload(data,mode=boardMode){
  boardRevision = Number(data?.revision || 0);
  if(mode==='carousels'){
    cards=Array.isArray(data?.cards)?data.cards:[];
    setCardBaselines(cards);
    setSettingsBaseline();
    return;
  }
  if(data)parseBoardData(data);
  else{cards=[];boardSettings=defaultSettings();}
  setCardBaselines(cards);
  setSettingsBaseline();
}
function cacheFirebaseBoardPayload(mode,payload){
  try{localStorage.setItem(firebaseBoardCacheKey(mode),JSON.stringify({cachedAt:Date.now(),payload}));}catch(e){}
}
function restoreFirebaseBoardCache(mode=boardMode){
  try{
    const raw=localStorage.getItem(firebaseBoardCacheKey(mode));
    if(!raw)return false;
    const cached=JSON.parse(raw);
    applyBoardPayload(cached.payload,mode);
    return true;
  }catch(e){return false;}
}
function firebaseUserFromDoc(doc){
  const data=doc.data()||{};
  return {
    id:doc.id,
    username:data.displayName||data.email||doc.id,
    email:data.email||'',
    role:data.role||'user',
    active:data.active===true,
    mustChangePassword:data.mustChangePassword===true,
    createdAt:data.createdAt||''
  };
}

async function firebaseCurrentUser(){
  initFirebaseBackend();
  if(firebaseAuth.currentUser)return firebaseAuth.currentUser;
  return new Promise(resolve=>{
    const unsub=firebaseAuth.onAuthStateChanged(user=>{unsub();resolve(user||null);});
  });
}

async function firebaseSessionFromAuthUser(authUser){
  if(!authUser)return null;
  const doc=await firebaseDb.collection('users').doc(authUser.uid).get();
  if(!doc.exists)throw new Error('Your account is not enabled for this board.');
  const user=firebaseUserFromDoc(doc);
  if(!user.active)throw new Error('Your account is disabled.');
  return {
    userId:authUser.uid,
    username:user.username,
    email:user.email||authUser.email||'',
    role:user.role,
    mustChangePassword:user.mustChangePassword===true,
    expiresAt:Date.now()+SESSION_DURATION_MS
  };
}

async function firebaseLoadUsers(){
  initFirebaseBackend();
  if(currentSession?.role!=='admin'&&firebaseAuth.currentUser){
    const doc=await firebaseDb.collection('users').doc(firebaseAuth.currentUser.uid).get();
    boardUsers=doc.exists?[firebaseUserFromDoc(doc)]:[];
    return true;
  }
  const snap=await firebaseDb.collection('users').get();
  boardUsers=snap.docs.map(firebaseUserFromDoc).filter(u=>u.active!==false);
  return true;
}

async function firebaseSaveUsers(){
  initFirebaseBackend();
  const batch=firebaseDb.batch();
  boardUsers.forEach(u=>{
    batch.set(firebaseDb.collection('users').doc(u.id),{
      email:u.email||'',
      displayName:u.username||u.email||'',
      role:u.role||'user',
      active:u.active!==false
    },{merge:true});
  });
  await batch.commit();
}

async function firebaseUploadFileWithProgress(file,subfolder,onProgress){
  return firebaseUploadBlobWithProgress(file,file.name,subfolder,onProgress,file.type);
}

async function firebaseUploadBlobWithProgress(blob,filename,subfolder,onProgress,contentType){
  initFirebaseBackend();
  const safeName=String(filename||'file').replace(/[^\w.\-]+/g,'_').slice(-140)||'file';
  const path=`uploads/${subfolder}/${Date.now()}_${uid()}_${safeName}`;
  const ref=firebaseStorage.ref(path);
  // contentDisposition:'attachment' tells the browser to save the file
  // straight to disk instead of opening/previewing it inline — this is what
  // makes the download button trigger a real browser download immediately,
  // with no fetch()/blob plumbing (and so nothing for ad-blockers to break).
  const task=ref.put(blob,{contentType:contentType||blob.type||'application/octet-stream',contentDisposition:`attachment; filename="${safeName}"`});
  const snap=await new Promise((resolve,reject)=>{
    task.on('state_changed',s=>{
      if(s.totalBytes)onProgress?.(Math.max(1,Math.round((s.bytesTransferred/s.totalBytes)*100)));
    },reject,()=>resolve(task.snapshot));
  });
  const downloadUrl=await snap.ref.getDownloadURL();
  onProgress?.(100);
  return{shareUrl:downloadUrl,itemId:path,downloadUrl};
}

async function firebaseDeleteFile(path){
  if(!path)return;
  initFirebaseBackend();
  await firebaseStorage.ref(path).delete();
}

async function firebaseRefreshDownloadUrl(path){
  if(!path)return null;
  initFirebaseBackend();
  return firebaseStorage.ref(path).getDownloadURL();
}

// ========== SESSION ==========
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); currentSession = s; }
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.expiresAt || Date.now() > s.expiresAt) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch(e) { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); currentSession = null; }

// ========== USERS ==========
async function loadUsers() {
  return firebaseLoadUsers();
}

async function saveUsers() {
  return firebaseSaveUsers();
}

async function validateCredentials(username, password) {
  initFirebaseBackend();
  const credential=await firebaseAuth.signInWithEmailAndPassword(username, password);
  const session=await firebaseSessionFromAuthUser(credential.user);
  return {id:session.userId,username:session.username,email:session.email,role:session.role,_session:session};
}

// ========== AUTH / SCREENS ==========
function showScreen(id) {
  ['loginScreen','changePwScreen'].forEach(s => {
    document.getElementById(s).style.display = 'none';
  });
  document.getElementById('app').style.display = 'none';
  if (id === 'app') { document.getElementById('app').style.display = 'block'; return; }
  if (id) { document.getElementById(id).style.display = 'flex'; }
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = 'Enter username and password'; return; }
  const btn = document.getElementById('loginSubmitBtn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const user = await validateCredentials(username, password);
    if (!user) { errEl.textContent = 'Incorrect username or password'; btn.disabled=false; btn.textContent='Sign in'; return; }
    const session = user._session;
    if (session.mustChangePassword) {
      pendingChangePwSession = session;
      document.getElementById('changePwUsername').textContent = session.username || session.email || '';
      document.getElementById('changePwError').textContent = '';
      document.getElementById('changePwNew').value = '';
      document.getElementById('changePwConfirm').value = '';
      showScreen('changePwScreen');
      btn.disabled = false; btn.textContent = 'Sign in';
      return;
    }
    saveSession(session);
    await startBoardApp(session);
  } catch(e) { errEl.textContent = 'Error: ' + e.message; }
  btn.disabled = false; btn.textContent = 'Sign in';
}

async function doChangePassword() {
  const newPw = document.getElementById('changePwNew').value;
  const confirmPw = document.getElementById('changePwConfirm').value;
  const errEl = document.getElementById('changePwError');
  errEl.textContent = '';
  if (!pendingChangePwSession) { showScreen('loginScreen'); return; }
  if (!newPw || newPw.length < 8) { errEl.textContent = 'Password must be at least 8 characters'; return; }
  if (newPw !== confirmPw) { errEl.textContent = 'Passwords do not match'; return; }
  const btn = document.getElementById('changePwSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const authUser = firebaseAuth.currentUser;
    if (!authUser) throw new Error('Session expired, please sign in again');
    await authUser.updatePassword(newPw);
    await firebaseDb.collection('users').doc(authUser.uid).set({mustChangePassword:false},{merge:true});
    const session = pendingChangePwSession;
    session.mustChangePassword = false;
    pendingChangePwSession = null;
    saveSession(session);
    document.getElementById('changePwNew').value = '';
    document.getElementById('changePwConfirm').value = '';
    await startBoardApp(session);
    return;
  } catch(e) {
    errEl.textContent = e.code === 'auth/requires-recent-login'
      ? 'For security, please sign out and sign in again, then retry.'
      : ('Error: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Set password & continue';
}

async function doLogout() {
  closeAccountMenu();
  clearSyncTimers();
  if(firebaseAuth){
    try{await firebaseAuth.signOut();}catch(e){}
  }
  clearSession();
  pendingChangePwSession = null;
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
  showScreen('loginScreen');
}

function setAccountMenu(session){
  const label=session.username||'User';
  const email=session.email||label;
  const initialsText=initials(label);
  document.getElementById('userAvatar').textContent=initialsText;
  document.getElementById('userAvatar').title='Account';
  document.getElementById('userAvatar').setAttribute('aria-expanded','false');
  document.getElementById('accountMenuAvatar').textContent=initialsText;
  document.getElementById('accountMenuName').textContent=label;
  document.getElementById('accountMenuEmail').textContent=email;
  document.getElementById('accountMenuRole').textContent=session.role==='admin'?'Admin':'User';
}

function toggleAccountMenu(){
  const menu=document.getElementById('accountMenu');
  const avatar=document.getElementById('userAvatar');
  const open=!menu.classList.contains('open');
  menu.classList.toggle('open',open);
  avatar.setAttribute('aria-expanded',open?'true':'false');
}

function closeAccountMenu(){
  const menu=document.getElementById('accountMenu');
  const avatar=document.getElementById('userAvatar');
  if(!menu||!avatar)return;
  menu.classList.remove('open');
  avatar.setAttribute('aria-expanded','false');
}

function clearSyncTimers(){
  if(boardSnapshotUnsub){boardSnapshotUnsub();boardSnapshotUnsub=null;}
  boardSnapshotMode=null;
  pendingSnapshotPayload=null;
}

function boardUiBusy(){
  return document.getElementById('modalBg')?.classList.contains('open')||!!pendingDelete;
}

function renderSyncedBoard(){
  refreshOptionLists();
  updateSettingsAccess();
  updateFilterBadge();
  renderStagePills();
  renderAll();
}

function applySyncedBoardPayload(mode,payload,{fromCache=false}={}){
  if(mode!==boardMode)return;
  if(boardUiBusy()){
    pendingSnapshotPayload={mode,payload,fromCache};
    return;
  }
  applyBoardPayload(payload,mode);
  cacheFirebaseBoardPayload(mode,payload||{version:mode==='carousels'?1:2,cards,settings:mode==='videos'?normalizeSettings(getSettings()):undefined});
  renderSyncedBoard();
  if(!fromCache)setSyncDot('ok');
  refreshDisplayUrls({onlyMissing:true}).then(()=>renderAll()).catch(()=>{});
}

function flushPendingSnapshot(){
  if(!pendingSnapshotPayload||boardUiBusy())return;
  const pending=pendingSnapshotPayload;
  pendingSnapshotPayload=null;
  applySyncedBoardPayload(pending.mode,pending.payload,{fromCache:pending.fromCache});
}

function subscribeFirebaseBoard(mode=boardMode){
  initFirebaseBackend();
  if(boardSnapshotUnsub&&boardSnapshotMode===mode)return Promise.resolve(false);
  if(boardSnapshotUnsub){boardSnapshotUnsub();boardSnapshotUnsub=null;}
  boardSnapshotMode=mode;
  setSyncDot('syncing');
  return new Promise((resolve,reject)=>{
    let first=true;
    let latestCards=null;
    let latestMeta=null;
    let lastFromCache=false;
    const applyLatest=()=>{
      if(!latestCards)return;
      const payload={
        version:mode==='carousels'?1:2,
        cards:latestCards,
        settings:mode==='videos'?normalizeSettings(latestMeta?.settings):undefined,
        revision:Number(latestMeta?.revision||0)
      };
      applySyncedBoardPayload(mode,payload,{fromCache:lastFromCache});
    };
    const fail=err=>{
        console.warn('Board realtime sync failed',err);
        setSyncDot('error');
        if(first){first=false;reject(err);}
    };
    const metaUnsub=firebaseBoardRef(mode).onSnapshot(async doc=>{
      // Capture seq immediately so we can detect if a delete committed while
      // we were awaiting async work below and discard this stale callback.
      const mySeq=boardSnapshotSeq;
      try{
        latestMeta=doc.exists?doc.data():{};
        lastFromCache=doc.metadata?.fromCache;
        if(latestCards&&await migrateLegacyCardsIfNeeded(mode,latestMeta,latestCards))return;
        if(boardSnapshotSeq!==mySeq)return;
        applyLatest();
      }catch(e){fail(e);}
    },fail);
    const cardsUnsub=firebaseCardsRef(mode).onSnapshot(async snap=>{
      // Same: capture seq at fire time, bail before applyLatest() if a
      // delete committed while the async migration check was in flight.
      const mySeq=boardSnapshotSeq;
      try{
        latestCards=cardsFromSnapshot(snap);
        lastFromCache=snap.metadata?.fromCache;
        if(!latestCards.length){
          const metaSnap=await firebaseBoardRef(mode).get();
          const meta=metaSnap.exists?metaSnap.data():null;
          if(await migrateLegacyCardsIfNeeded(mode,meta,[]))return;
        }else if(await migrateLegacyCardsIfNeeded(mode,latestMeta,latestCards)){
          return;
        }
        if(boardSnapshotSeq!==mySeq)return;
        applyLatest();
        if(first){first=false;resolve(true);}
      }catch(e){fail(e);}
    },fail);
    boardSnapshotUnsub=()=>{metaUnsub();cardsUnsub();};
  });
}

// ========== INIT ==========
async function init(){
  setLoading(20);
  try{
    initFirebaseBackend();
    const authUser=await firebaseCurrentUser();
    setLoading(60);
    if(authUser){
      const session=await firebaseSessionFromAuthUser(authUser);
      if(session.mustChangePassword){
        pendingChangePwSession=session;
        document.getElementById('changePwUsername').textContent=session.username||session.email||'';
        document.getElementById('changePwError').textContent='';
        document.getElementById('changePwNew').value='';
        document.getElementById('changePwConfirm').value='';
        setLoading(100);setTimeout(()=>setLoading(0),400);
        showScreen('changePwScreen');
        return;
      }
      saveSession(session);
      await loadUsers();
      setLoading(100);setTimeout(()=>setLoading(0),400);
      await startBoardApp(session);
      return;
    }
  }catch(e){
    showToast('Firebase connection failed: '+e.message,'error');
    setLoading(0);
  }
  setLoading(100);setTimeout(()=>setLoading(0),400);
  showScreen('loginScreen');
}

async function startBoardApp(session){
  currentSession=session;
  clearSyncTimers();
  showScreen('app');
  setAccountMenu(session);
  document.getElementById('openAddBtn').textContent='+ New Video';
  setLoading(30);
  const renderedCache=restoreFirebaseBoardCache(boardMode);
  if(renderedCache){
    refreshOptionLists();
    updateSettingsAccess();
    updateFilterBadge();
    renderStagePills();
    renderAll();
    setLoading(55);
  }
  try{
    await loadUsers();
    await subscribeFirebaseBoard(boardMode);
    setLoading(80);
  }catch(e){showToast('Board load error: '+e.message,'error');setLoading(0);}
  refreshOptionLists();
  updateSettingsAccess();
  updateFilterBadge();
  renderStagePills();
  renderAll();
  setLoading(100);setTimeout(()=>setLoading(0),400);
  // Refresh display URLs in background — re-render when done
  refreshDisplayUrls({onlyMissing:true}).then(()=>renderAll()).catch(()=>{});
}

// ========== BOARD DATA ==========
function parseBoardData(data){
  if(Array.isArray(data)){cards=data;boardSettings=defaultSettings();return;}
  cards=Array.isArray(data?.cards)?data.cards:[];
  boardSettings=normalizeSettings(data?.settings);
}

function buildBoardPayload(){return{version:2,settings:normalizeSettings(getSettings()),cards};}

async function migrateLegacyCardsIfNeeded(mode,legacyData,existingCards=[]){
  if(!Array.isArray(legacyData?.cards)||!legacyData.cards.length)return false;
  const existingIds=new Set(
    Array.isArray(existingCards)
      ? existingCards.map(card=>typeof card==='string'?card:card?.id).filter(Boolean)
      : []
  );
  const missingLegacyCards=legacyData.cards.filter(raw=>raw?.id&&!existingIds.has(raw.id));
  if(!missingLegacyCards.length)return false;
  const batch=firebaseDb.batch();
  missingLegacyCards.forEach((raw,index)=>{
    const card={...raw,id:raw.id||uid(),sortIndex:Number.isFinite(raw.sortIndex)?raw.sortIndex:index,_rev:Number(raw._rev||0)};
    const ref=firebaseCardsRef(mode).doc(card.id);
    batch.set(ref,{...cleanCardForStorage(card),_rev:card._rev});
  });
  batch.set(firebaseBoardRef(mode),{
    version:mode==='carousels'?1:2,
    settings:mode==='videos'?normalizeSettings(legacyData.settings):firebase.firestore.FieldValue.delete(),
    revision:Number(legacyData.revision||0),
    migratedFromArrayAt:firebase.firestore.FieldValue.serverTimestamp()
  },{merge:true});
  await batch.commit();
  return true;
}

async function loadData(){
  const mode=boardMode;
  const [metaDoc,cardsSnap]=await Promise.all([firebaseBoardRef(mode).get(),firebaseCardsRef(mode).get()]);
  const meta=metaDoc.exists?metaDoc.data():null;
  if(!cardsSnap.empty){
    cards=cardsFromSnapshot(cardsSnap);
    if(await migrateLegacyCardsIfNeeded(mode,meta,cards)){
      return loadData();
    }
    boardRevision=Number(meta?.revision||0);
    if(mode==='videos')boardSettings=normalizeSettings(meta?.settings);
    else boardSettings=boardSettings||defaultSettings();
    setCardBaselines(cards);
    setSettingsBaseline();
    cacheFirebaseBoardPayload(mode,{version:mode==='carousels'?1:2,cards,settings:mode==='videos'?normalizeSettings(getSettings()):undefined,revision:boardRevision});
    return;
  }
  if(await migrateLegacyCardsIfNeeded(mode,meta,[])){
    return loadData();
  }
  applyBoardPayload(meta,mode);
  cacheFirebaseBoardPayload(mode,meta||{version:mode==='carousels'?1:2,cards,settings:mode==='videos'?normalizeSettings(getSettings()):undefined});
}

async function saveData(){
  const mode=boardMode;
  const currentIds=new Set(cards.map(c=>c.id).filter(Boolean));
  const changed=cards.filter(c=>!cardBaselineData.has(c.id)||cardBaselineData.get(c.id)!==cardBaselineJson(c));
  const deleted=[...cardBaselineData.keys()].filter(id=>!currentIds.has(id));
  const settingsJson=JSON.stringify(normalizeSettings(getSettings()));
  const settingsChanged=mode==='videos'&&settingsJson!==settingsBaselineJson;
  const savedCardRevs=new Map();

  const nextBoardRevision=await firebaseDb.runTransaction(async tx=>{
    savedCardRevs.clear();
    const metaRef=firebaseBoardRef(mode);
    const metaSnap=await tx.get(metaRef);
    const remoteRevision=Number(metaSnap.exists?(metaSnap.data()?.revision||0):0);
    if(settingsChanged&&remoteRevision!==boardRevision){
      throw new Error('Settings changed in another session. Close settings, review the latest board, then retry.');
    }

    const changedReads=[];
    for(const card of changed){
      const ref=firebaseCardsRef(mode).doc(card.id);
      const snap=await tx.get(ref);
      changedReads.push({card,ref,snap});
    }
    const deletedReads=[];
    for(const id of deleted){
      const ref=firebaseCardsRef(mode).doc(id);
      const snap=await tx.get(ref);
      deletedReads.push({id,ref,snap});
    }

    for(const {card,ref,snap} of changedReads){
      const remoteRev=Number(snap.exists?(snap.data()?._rev||0):0);
      const expectedRev=Number(cardBaselineRev.get(card.id)||0);
      if(remoteRev!==expectedRev){
        throw new Error(`"${card.name||'This card'}" changed in another session. Close this editor, review the latest card, then retry.`);
      }
      const nextRev=remoteRev+1;
      savedCardRevs.set(card.id,nextRev);
      tx.set(ref,{
        ...cleanCardForStorage(card),
        sortIndex:cards.findIndex(item=>item.id===card.id),
        _rev:nextRev,
        updatedAt:card.updatedAt||new Date().toISOString(),
        updatedAtMs:Date.now(),
        updatedBy:currentSession?.userId||null
      },{merge:false});
    }

    for(const {id,ref,snap} of deletedReads){
      if(snap.exists){
        const remoteRev=Number(snap.data()?._rev||0);
        const expectedRev=Number(cardBaselineRev.get(id)||0);
        if(remoteRev!==expectedRev){
          throw new Error('A deleted card changed in another session. Refresh and retry.');
        }
        tx.delete(ref);
      }
    }

    const nextRevision=settingsChanged?remoteRevision+1:remoteRevision;
    tx.set(metaRef,{
      version:mode==='carousels'?1:2,
      ...(mode==='videos'?{settings:normalizeSettings(getSettings())}:{}),
      revision:nextRevision,
      updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedAtMs:Date.now(),
      updatedBy:currentSession?.userId||null,
      storageModel:'cards-subcollection'
    },{merge:true});
    return nextRevision;
  });

  boardRevision=nextBoardRevision;
  cards.forEach(card=>{
    if(savedCardRevs.has(card.id))card._rev=savedCardRevs.get(card.id);
  });
  setCardBaselines(cards);
  setSettingsBaseline();
  cacheFirebaseBoardPayload(mode,{version:mode==='carousels'?1:2,cards,settings:mode==='videos'?normalizeSettings(getSettings()):undefined,revision:boardRevision});
}

async function switchBoardMode(mode){
  if(boardMode===mode)return;
  // Clear board immediately so old cards don't flash under new mode
  if(boardSnapshotUnsub){boardSnapshotUnsub();boardSnapshotUnsub=null;}
  boardSnapshotMode=null;
  pendingSnapshotPayload=null;
  cards=[];
  setLoading(20);
  document.getElementById('board').innerHTML='';
  document.getElementById('statsBar').innerHTML='';
  boardMode=mode;
  document.querySelectorAll('.board-tab').forEach(t=>t.classList.toggle('active',t.dataset.mode===mode));
  const label=mode==='videos'?'Videos':'Carousels';
  document.getElementById('openAddBtn').textContent='+ New '+label.slice(0,-1);
  document.getElementById('modalTitle').textContent='New '+label.slice(0,-1);
  document.getElementById('fpHasVidLabel').style.display=mode==='carousels'?'none':'';
  clearAllFilters();
  setLoading(40);
  const renderedCache=restoreFirebaseBoardCache(mode);
  if(renderedCache){
    refreshOptionLists();
    renderStagePills();
    renderAll();
    setLoading(60);
  }
  try{
    await subscribeFirebaseBoard(mode);
    if(mode==='carousels')carouselLoaded=true;
    setLoading(90);
  }catch(e){showToast('Error loading '+mode+': '+e.message,'error');setLoading(0);}
  refreshOptionLists();
  renderStagePills();
  activeFilters.stage='';
  renderAll();
  setLoading(100);setTimeout(()=>setLoading(0),400);
  refreshDisplayUrls({onlyMissing:true}).then(()=>renderAll()).catch(()=>{});
}

async function uploadFileWithProgress(file,subfolder,onProgress){
  return firebaseUploadFileWithProgress(file,subfolder,onProgress);
}

function setTransferStatus(el,label,pct=null,variant=''){
  if(!el)return;
  el.className='upload-status transfer-status '+variant;
  const pctText=typeof pct==='number'?` ${Math.max(0,Math.min(100,Math.round(pct)))}%`:'';
  const barClass=typeof pct==='number'?'':' indeterminate';
  const barStyle=typeof pct==='number'?` style="width:${Math.max(2,Math.min(100,Math.round(pct)))}%"`:'';
  el.innerHTML=`<span>${escHtml(label)}${pctText}</span><div class="transfer-bar${barClass}"><span${barStyle}></span></div>`;
}

function setPlainStatus(el,msg,type=''){
  if(!el)return;
  el.className='upload-status '+type;
  el.textContent=msg;
}

async function fetchBlobWithProgress(url,onProgress){
  const res=await fetch(url);
  if(!res.ok)throw new Error(`Download failed: ${res.status}`);
  const total=Number(res.headers.get('Content-Length'))||0;
  if(!res.body){
    onProgress?.(null);
    const blob=await res.blob();
    onProgress?.(100);
    return blob;
  }
  const reader=res.body.getReader();
  const chunks=[];
  let received=0;
  onProgress?.(total?0:null);
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    chunks.push(value);
    received+=value.length;
    if(total)onProgress?.(Math.round((received/total)*100));
  }
  onProgress?.(100);
  return new Blob(chunks,{type:res.headers.get('Content-Type')||'application/octet-stream'});
}

function triggerBlobDownload(blob,filename){
  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=objectUrl;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
}


async function refreshDisplayUrls({onlyMissing=false}={}){
  await mapLimit(cards,5,async c=>{
    if(c.thumbItemId&&(!onlyMissing||!c.thumbDisplayUrl)){try{c.thumbDisplayUrl=await firebaseRefreshDownloadUrl(c.thumbItemId);}catch(e){}}
    if(c.vidItemId&&(!onlyMissing||!c.vidDisplayUrl)){try{c.vidDisplayUrl=await firebaseRefreshDownloadUrl(c.vidItemId);}catch(e){}}
    if(Array.isArray(c.images)&&c.images.length){
      await mapLimit(c.images,4,async img=>{
        if(img.itemId&&(!onlyMissing||!img.downloadUrl)){try{img.downloadUrl=await firebaseRefreshDownloadUrl(img.itemId);}catch(e){}}
      });
    }
  });
}

// ========== SETTINGS ==========
function defaultSettings(){return{categories:[...DEFAULT_CATEGORIES],people:[]};}
function normalizeSettings(input){
  const base=defaultSettings();
  const categories=uniqueList(Array.isArray(input?.categories)?input.categories:base.categories);
  const peopleSource=Array.isArray(input?.people)?input.people:base.people;
  const people=peopleSource.map(p=>({id:String(p.id||uid()),name:String(p.name||'').trim(),roles:Array.isArray(p.roles)?p.roles.filter(r=>ROLE_DEFS.some(def=>def.key===r)):[]})).filter(p=>p.name);
  return{categories:categories.length?categories:[...DEFAULT_CATEGORIES],people};
}
function getSettings(){if(!boardSettings)boardSettings=defaultSettings();return boardSettings;}
function cloneSettings(s){return JSON.parse(JSON.stringify(s));}
function canManageSettings(){return!!(currentSession&&currentSession.role==='admin');}
function updateSettingsAccess(){
  const btn=document.getElementById('openSettingsBtn');
  if(btn){
    const allowed=canManageSettings();
    btn.style.display=allowed?'':'none';
    btn.disabled=!allowed;
    if(!allowed&&document.getElementById('settingsBg').classList.contains('open'))closeSettings();
  }
  // Posting is an admin-only tool — regular users shouldn't see or open it.
  const postingBtn=document.getElementById('openPostingBtn');
  if(postingBtn){
    const allowedPosting=canManageSettings();
    postingBtn.style.display=allowedPosting?'':'none';
    postingBtn.disabled=!allowedPosting;
    if(!allowedPosting&&document.getElementById('postingOverlay').classList.contains('open'))closePosting();
  }
}

function uniqueList(values){
  const seen=new Set();
  return values.map(v=>String(v||'').trim()).filter(v=>{if(!v||seen.has(v))return false;seen.add(v);return true;});
}

function usedValues(field){return cards.map(c=>c[field]).filter(Boolean);}
function peopleForRole(role,field){
  const settings=getSettings();
  return uniqueList([...settings.people.filter(p=>p.roles.includes(role)).map(p=>p.name),...usedValues(field)]);
}
function categoriesForOptions(){return uniqueList([...getSettings().categories,...usedValues('category')]);}
function setSelectOptions(id,values,blankLabel){
  const el=document.getElementById(id);if(!el)return;
  const previous=el.value;
  const opts=uniqueList(values);
  el.innerHTML=[blankLabel!=null?`<option value="">${escHtml(blankLabel)}</option>`:'',...opts.map(v=>`<option value="${escHtml(v)}">${escHtml(v)}</option>`)].join('');
  if(previous&&opts.includes(previous))el.value=previous;
  else if(blankLabel!=null)el.value='';
  else if(opts.length)el.value=opts[0];
}
function refreshOptionLists(){
  const categories=categoriesForOptions();
  // Filter panel selects
  setSelectOptions('fpCategory',categories,'All');
  setSelectOptions('fpPresenter',peopleForRole('presenter','presenter'),'All');
  setSelectOptions('fpAssign',peopleForRole('assigned','assign'),'All');
  setSelectOptions('fpEditor',peopleForRole('editor','editor'),'All');
  // Modal form selects
  setSelectOptions('fCategory',categories,null);
  setSelectOptions('fPresenter',peopleForRole('presenter','presenter'),'—');
  setSelectOptions('fAssign',peopleForRole('assigned','assign'),'—');
  setSelectOptions('fEditor',peopleForRole('editor','editor'),'—');
  setSelectOptions('fApprove',peopleForRole('approver','approve'),'—');
  // Restore active filter values in panel
  if(activeFilters.category)document.getElementById('fpCategory').value=activeFilters.category;
  if(activeFilters.presenter)document.getElementById('fpPresenter').value=activeFilters.presenter;
  if(activeFilters.assign)document.getElementById('fpAssign').value=activeFilters.assign;
  if(activeFilters.editor)document.getElementById('fpEditor').value=activeFilters.editor;
}

// ========== USERS SETTINGS ==========
function renderUsersSettings(){
  if(!canManageSettings())return;
  const firebaseNote=`
    <div class="settings-help" style="margin-bottom:8px">
      Add new users from Firebase Authentication, then create their Firestore user profile with the same UID.
    </div>`;
  document.getElementById('usersSettingsList').innerHTML=firebaseNote+boardUsers.map((u,i)=>`
    <div class="user-row">
      <div>
        <div class="user-row-info">
          <span style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(u.username)}</span>
          <span class="user-badge ${u.role==='admin'?'admin':'user-role'}">${u.role}</span>
          ${u.mustChangePassword?'<span class="user-badge must-change">must change password</span>':''}
          ${u.username===currentSession?.username?'<span style="font-size:10px;color:var(--text3)">(you)</span>':''}
        </div>
        <div class="user-actions" style="margin-top:6px">
          <button class="user-action-btn" onclick="toggleUserRole(${i})">${u.role==='admin'?'Make user':'Make admin'}</button>
          ${u.username!==currentSession?.username&&!u.mustChangePassword?`<button class="user-action-btn" onclick="forcePasswordChange(${i})">Force password change</button>`:''}
          ${u.username!==currentSession?.username?`<button class="user-action-btn" style="color:#f87171;border-color:#7f1d1d" onclick="deleteUser(${i})">Delete</button>`:''}
        </div>
      </div>
    </div>`).join('');
}

async function forcePasswordChange(i){
  if(!canManageSettings())return;
  const u=boardUsers[i];
  if(u.username===currentSession?.username||u.mustChangePassword)return;
  if(!confirm(`Ask ${u.username} to set a new password on their next sign-in?`))return;
  try{
    initFirebaseBackend();
    await firebaseDb.collection('users').doc(u.id).set({mustChangePassword:true},{merge:true});
    boardUsers[i].mustChangePassword=true;
    renderUsersSettings();
    showToast(`${u.username} will be asked to set a new password`,'success');
  }catch(e){showToast('Error: '+e.message,'error');}
}

async function toggleUserRole(i){
  if(!canManageSettings())return;
  boardUsers[i].role=boardUsers[i].role==='admin'?'user':'admin';
  try{await saveUsers();renderUsersSettings();showToast('Role updated','success');}
  catch(e){showToast('Error: '+e.message,'error');}
}

async function deleteUser(i){
  if(!canManageSettings())return;
  const u=boardUsers[i];
  if(u.username===currentSession?.username)return;
  boardUsers[i].active=false;
  try{await saveUsers();await loadUsers();renderUsersSettings();showToast(`${u.username} disabled`,'success');}
  catch(e){showToast('Error: '+e.message,'error');}
}

// ========== PEOPLE/CATEGORY SETTINGS ==========
function openSettings(){
  if(!canManageSettings()){showToast('Settings restricted for this account','error');return;}
  settingsDraft=cloneSettings(getSettings());
  renderSettings();
  renderUsersSettings();
  document.getElementById('settingsBg').classList.add('open');
}
function closeSettings(){document.getElementById('settingsBg').classList.remove('open');settingsDraft=null;}

function renderSettings(){
  if(!canManageSettings()||!settingsDraft)return;
  document.getElementById('peopleSettingsList').innerHTML=settingsDraft.people.map((p,i)=>`
    <div class="settings-row">
      <div class="settings-row-main">
        <input class="settings-input person-name-input" data-index="${i}" value="${escHtml(p.name)}" placeholder="Person name">
        <div class="role-checks">
          ${ROLE_DEFS.map(role=>`
            <label class="role-check">
              <input type="checkbox" class="person-role-input" data-index="${i}" data-role="${role.key}" ${p.roles.includes(role.key)?'checked':''}>
              ${escHtml(role.label)}
            </label>`).join('')}
        </div>
      </div>
      <button class="settings-delete delete-person-btn" data-index="${i}">Delete</button>
    </div>`).join('');
  document.getElementById('categorySettingsList').innerHTML=settingsDraft.categories.map((cat,i)=>`
    <div class="settings-row">
      <div class="settings-row-main">
        <input class="settings-input category-name-input" data-index="${i}" value="${escHtml(cat)}" placeholder="Category name">
      </div>
      <button class="settings-delete delete-category-btn" data-index="${i}">Delete</button>
    </div>`).join('');
  document.querySelectorAll('.person-name-input').forEach(el=>{el.addEventListener('input',()=>{settingsDraft.people[parseInt(el.dataset.index)].name=el.value;});});
  document.querySelectorAll('.person-role-input').forEach(el=>{
    el.addEventListener('change',()=>{
      const person=settingsDraft.people[parseInt(el.dataset.index)];
      const roles=new Set(person.roles);
      if(el.checked)roles.add(el.dataset.role);else roles.delete(el.dataset.role);
      person.roles=[...roles];
    });
  });
  document.querySelectorAll('.delete-person-btn').forEach(el=>{el.addEventListener('click',()=>{settingsDraft.people.splice(parseInt(el.dataset.index),1);renderSettings();});});
  document.querySelectorAll('.category-name-input').forEach(el=>{el.addEventListener('input',()=>{settingsDraft.categories[parseInt(el.dataset.index)]=el.value;});});
  document.querySelectorAll('.delete-category-btn').forEach(el=>{el.addEventListener('click',()=>{settingsDraft.categories.splice(parseInt(el.dataset.index),1);renderSettings();});});
}

function addSettingsPerson(){
  if(!canManageSettings())return;
  const input=document.getElementById('newPersonName');
  const name=input.value.trim();if(!name)return;
  if(!settingsDraft)settingsDraft=cloneSettings(getSettings());
  if(!settingsDraft.people.some(p=>p.name.toLowerCase()===name.toLowerCase())){
    settingsDraft.people.push({id:'person-'+uid(),name,roles:ROLE_DEFS.map(r=>r.key)});
  }
  input.value='';renderSettings();
}

function addSettingsCategory(){
  if(!canManageSettings())return;
  const input=document.getElementById('newCategoryName');
  const name=input.value.trim();if(!name)return;
  if(!settingsDraft)settingsDraft=cloneSettings(getSettings());
  if(!settingsDraft.categories.some(c=>c.toLowerCase()===name.toLowerCase())){settingsDraft.categories.push(name);}
  input.value='';renderSettings();
}

async function saveSettings(){
  if(!canManageSettings()){showToast('Settings restricted','error');return;}
  if(!settingsDraft)return;
  const btn=document.getElementById('saveSettingsBtn');
  btn.textContent='Saving...';btn.disabled=true;
  try{
    boardSettings=normalizeSettings(settingsDraft);
    refreshOptionLists();
    await saveData();
    closeSettings();renderAll();
    showToast('Settings saved','success');
  }catch(e){showToast('Save failed: '+e.message,'error');}
  btn.textContent='Save settings';btn.disabled=false;
}

// ========== BOARD RENDER ==========
function setSyncDot(state){
  const d=document.getElementById('syncDot');if(!d)return;
  if(state==='syncing'){d.style.background='#e8a83b';}
  else if(state==='ok'){d.style.background='#5ae8a0';setTimeout(()=>{d.style.background='var(--border2)';},2000);}
  else if(state==='error'){d.style.background='#f87171';setTimeout(()=>{d.style.background='var(--border2)';},4000);}
}

async function forceRefreshBoard(){
  if(boardUiBusy()){showToast('Close the open editor before refreshing the board.','error');return;}
  setSyncDot('syncing');
  try{
    await loadData();
    renderSyncedBoard();
    await refreshDisplayUrls({onlyMissing:true}).catch(()=>{});
    renderAll();
    setSyncDot('ok');
    showToast('Board refreshed','success');
  }catch(e){
    setSyncDot('error');
    showToast('Refresh failed: '+e.message,'error');
  }
}

function showToast(msg,type=''){
  if(pendingDelete&&type!=='error')return;
  const t=document.getElementById('toast');
  t.textContent=msg;t.className='toast '+(type||'');
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3000);
}

function setLoading(pct){document.getElementById('loadingBar').style.width=pct+'%'}

function dueDateStatus(dueDate,stage){
  if(!dueDate||stage===currentStages().length-1)return null;
  const today=new Date();today.setHours(0,0,0,0);
  const due=parseLocalDate(dueDate);
  if(!due)return null;
  due.setHours(0,0,0,0);
  const diff=Math.round((due-today)/(864e5));
  if(diff<0)return'overdue';
  if(diff<=3)return'soon';
  return null;
}

function applyStageAudit(card,previousCard){
  const nowIso=new Date().toISOString();
  const previousStage=previousCard?previousCard.stage:null;
  card.stageHistory=Array.isArray(previousCard?.stageHistory)?previousCard.stageHistory.slice():[];
  card.updatedAt=nowIso;
  card.updatedBy=currentSession?.userId||null;
  if(previousStage!==card.stage){
    card.stageChangedAt=nowIso;
    card.stageHistory.push({from:previousStage,to:card.stage,at:nowIso,by:currentSession?.userId||null});
  }else{
    card.stageChangedAt=previousCard?.stageChangedAt||card.createdAt||nowIso;
  }
  const postedStage=currentStages().length-1;
  if(card.stage===postedStage)card.postedAt=previousCard?.postedAt||nowIso;
  else card.postedAt=null;
}

function avatarColor(name){
  if(!name)return'#333';
  if(AV_COLORS[name])return AV_COLORS[name];
  let hash=0;
  for(let i=0;i<name.length;i++)hash=(hash*31+name.charCodeAt(i))>>>0;
  const palette=['#1d4ed8','#6d28d9','#b45309','#065f46','#7c2d12','#0f766e','#be123c','#4338ca'];
  return palette[hash%palette.length];
}

function getFiltered(){
  const f=activeFilters;
  return cards.filter(c=>{
    if(f.q&&![c.name,c.channel,c.segment,c.presenter,c.assign,c.editor,c.seoTitle,c.seoDesc,c.script,c.notes].some(v=>v&&String(v).toLowerCase().includes(f.q)))return false;
    if(f.format&&c.format!==f.format)return false;
    if(f.stage!==''&&c.stage!==parseInt(f.stage))return false;
    if(f.category&&c.category!==f.category)return false;
    if(f.priority&&c.priority!==f.priority)return false;
    if(f.compliance&&c.compliance!==f.compliance)return false;
    if(f.presenter&&c.presenter!==f.presenter)return false;
    if(f.assign&&c.assign!==f.assign)return false;
    if(f.editor&&c.editor!==f.editor)return false;
    if(f.postDateFrom&&(!c.postDate||c.postDate<f.postDateFrom))return false;
    if(f.postDateTo&&(!c.postDate||c.postDate>f.postDateTo))return false;
    if(f.dueDateFrom&&(!c.dueDate||c.dueDate<f.dueDateFrom))return false;
    if(f.dueDateTo&&(!c.dueDate||c.dueDate>f.dueDateTo))return false;
    if(f.channel&&!((c.channel||'').toLowerCase().includes(f.channel.toLowerCase())))return false;
    if(f.segment&&!((c.segment||'').toLowerCase().includes(f.segment.toLowerCase())))return false;
    if(f.hasThumb&&!c.thumbUrl)return false;
    if(f.hasVid&&!c.vidUrl)return false;
    if(f.overdue&&dueDateStatus(c.dueDate,c.stage)!=='overdue')return false;
    if(f.dueSoon&&dueDateStatus(c.dueDate,c.stage)!=='soon')return false;
    return true;
  });
}

function countActiveFilters(){
  const f=activeFilters;
  let n=0;
  if(f.q)n++;if(f.format)n++;if(f.stage!=='')n++;if(f.category)n++;
  if(f.priority)n++;if(f.compliance)n++;if(f.presenter)n++;if(f.assign)n++;
  if(f.editor)n++;if(f.postDateFrom)n++;if(f.postDateTo)n++;
  if(f.dueDateFrom)n++;if(f.dueDateTo)n++;if(f.channel)n++;if(f.segment)n++;
  if(f.hasThumb)n++;if(f.hasVid)n++;if(f.overdue)n++;if(f.dueSoon)n++;
  return n;
}

function updateFilterBadge(){
  const n=countActiveFilters();
  const btn=document.getElementById('filterToggleBtn');
  const badge=document.getElementById('filterCount');
  badge.textContent=n;
  badge.style.display=n?'inline-block':'none';
  btn.classList.toggle('has-filters',n>0);
  btn.classList.toggle('active',filterPanelOpen);
}

function renderStagePills(){
  const grp=document.getElementById('fpStageGroup');
  const stages=currentStages();
  grp.innerHTML=`<button class="fp-pill active" data-val="">All</button>`
    +stages.map((s,i)=>`<button class="fp-pill" data-val="${i}">${s}</button>`).join('');
  grp.querySelectorAll('.fp-pill').forEach(btn=>{
    btn.addEventListener('click',()=>{
      activeFilters.stage=btn.dataset.val;
      document.querySelectorAll('#fpStageGroup .fp-pill').forEach(x=>x.classList.remove('active'));
      btn.classList.add('active');
      updateFilterBadge();renderAll();
    });
  });
}

function syncFilterPanelUI(){
  const f=activeFilters;
  // Stage pills
  document.querySelectorAll('#fpStageGroup .fp-pill').forEach(p=>{
    p.classList.toggle('active',p.dataset.val===String(f.stage)||(!p.dataset.val&&f.stage===''));
  });
  // Format pills
  document.querySelectorAll('#fpFormatGroup .fp-pill').forEach(p=>{
    p.classList.toggle('active',p.dataset.val===f.format);
  });
  // Selects
  ['fpCategory','fpPriority','fpCompliance','fpPresenter','fpAssign','fpEditor'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const key={fpCategory:'category',fpPriority:'priority',fpCompliance:'compliance',fpPresenter:'presenter',fpAssign:'assign',fpEditor:'editor'}[id];
    el.value=f[key]||'';
    el.classList.toggle('active',!!(f[key]));
  });
  // Dates
  ['fpPostFrom','fpPostTo','fpDueFrom','fpDueTo'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const key={fpPostFrom:'postDateFrom',fpPostTo:'postDateTo',fpDueFrom:'dueDateFrom',fpDueTo:'dueDateTo'}[id];
    el.value=f[key]||'';el.classList.toggle('active',!!f[key]);
  });
  // Text inputs
  document.getElementById('fpChannel').value=f.channel||'';
  document.getElementById('fpChannel').classList.toggle('active',!!f.channel);
  document.getElementById('fpSegment').value=f.segment||'';
  document.getElementById('fpSegment').classList.toggle('active',!!f.segment);
  // Checkboxes
  ['hasThumb','hasVid','overdue','dueSoon'].forEach(key=>{
    const idMap={hasThumb:'fpHasThumb',hasVid:'fpHasVid',overdue:'fpOverdue',dueSoon:'fpDueSoon'};
    const labelMap={hasThumb:'fpHasThumbLabel',hasVid:'fpHasVidLabel',overdue:'fpOverdueLabel',dueSoon:'fpDueSoonLabel'};
    const cb=document.getElementById(idMap[key]);
    if(cb)cb.checked=f[key];
    const lb=document.getElementById(labelMap[key]);
    if(lb)lb.classList.toggle('active',f[key]);
  });
}

function applyFilter(key,value){
  activeFilters[key]=value;
  updateFilterBadge();
  renderAll();
}

function clearAllFilters(){
  activeFilters={q:'',format:'',stage:'',category:'',priority:'',compliance:'',presenter:'',assign:'',editor:'',postDateFrom:'',postDateTo:'',dueDateFrom:'',dueDateTo:'',channel:'',segment:'',hasThumb:false,hasVid:false,overdue:false,dueSoon:false};
  document.getElementById('searchInput').value='';
  syncFilterPanelUI();
  updateFilterBadge();
  renderAll();
}

function toggleFilterPanel(){
  filterPanelOpen=!filterPanelOpen;
  document.getElementById('filterPanel').classList.toggle('open',filterPanelOpen);
  document.getElementById('filterToggleBtn').classList.toggle('active',filterPanelOpen);
}

function renderStats(fc){
  if(!fc)fc=getFiltered();
  const stages=currentStages();
  const isFiltering=fc.length!==cards.length;
  const fCounts=new Array(stages.length).fill(0);
  fc.forEach(c=>{if(c.stage>=0&&c.stage<stages.length)fCounts[c.stage]++;});
  let tCounts=fCounts;
  if(isFiltering){
    tCounts=new Array(stages.length).fill(0);
    cards.forEach(c=>{if(c.stage>=0&&c.stage<stages.length)tCounts[c.stage]++;});
  }
  document.getElementById('statsBar').innerHTML=stages.map((s,i)=>{
    const num=isFiltering?`${fCounts[i]}<span style="font-size:12px;color:var(--text3);font-weight:300">/${tCounts[i]}</span>`:`${fCounts[i]}`;
    return`<div class="stat"><div class="stat-num">${num}</div><div class="stat-label">${s}</div></div>`;
  }).join('');
}

function renderCard(c){
  const av=avatarColor(c.assign||c.presenter);
  const ini=escHtml(initials(c.assign||c.presenter||'?'));
  const catCls=CAT_TAG[c.category]||'tag-gen';
  const hasScript=!!(c.script&&c.script.trim());
  const thumbSrc=safeUrl(c.thumbDisplayUrl)||safeUrl(c.thumbUrl);
  const vidSrc=safeUrl(c.vidDisplayUrl)||safeUrl(c.vidUrl);
  const dueSt=dueDateStatus(c.dueDate,c.stage);
  const thumbTile=thumbSrc
    ?`<div class="card-media-item has-file" title="Thumbnail preview" onclick="event.stopPropagation();openLightbox('img',${jsArg(thumbSrc)},${jsArg(c.name||'')})"><img src="${escHtml(thumbSrc)}" onerror="this.parentElement.classList.remove('has-file');this.parentElement.innerHTML='<div class=&quot;card-media-empty&quot;><svg viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.5&quot;><rect x=&quot;3&quot; y=&quot;5&quot; width=&quot;18&quot; height=&quot;14&quot; rx=&quot;2&quot;/><path d=&quot;M3 14l4-4 3 3 4-5 4 6&quot;/></svg><span>Thumbnail</span></div>'"><span class="card-media-caption">Thumbnail</span></div>`
    :`<div class="card-media-item" title="No thumbnail"><div class="card-media-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14l4-4 3 3 4-5 4 6"/></svg><span>Thumbnail</span></div></div>`;
  const isCarouselCard=boardMode==='carousels';
  let mediaSectionHtml;
  if(isCarouselCard){
    const imgs=Array.isArray(c.images)&&c.images.length?c.images:((c.thumbDisplayUrl||c.thumbUrl)?[{downloadUrl:c.thumbDisplayUrl,shareUrl:c.thumbUrl}]:[]);
    if(!imgs.length){
      mediaSectionHtml=`<div class="card-media" style="grid-template-columns:1fr"><div class="card-media-item" style="aspect-ratio:16/9"><div class="card-media-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14l4-4 3 3 4-5 4 6"/></svg><span>No images</span></div></div></div>`;
    }else{
      const show=imgs.slice(0,4);
      const extra=imgs.length-4;
      const cols=show.length===1?1:2;
      const ratio=show.length===1?'16/9':'1/1';
      const tiles=show.map((img,idx)=>{
        const src=escHtml(safeUrl(img.downloadUrl||img.shareUrl)||'');
        const isLastExtra=idx===3&&extra>0;
        return`<div class="card-media-item has-file" style="aspect-ratio:${ratio};cursor:zoom-in" onclick="event.stopPropagation();openLightbox('img',${jsArg(safeUrl(img.downloadUrl||img.shareUrl))},${jsArg((c.name||'')+' · Slide '+(idx+1))})">
          <img src="${src}" onerror="this.style.display='none'">
          ${isLastExtra?`<div style="position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff">+${extra}</div>`:''}
          <span class="card-media-caption">Slide ${idx+1}</span>
        </div>`;
      }).join('');
      mediaSectionHtml=`<div class="card-media" style="grid-template-columns:repeat(${cols},1fr)">${tiles}</div>`;
    }
  }else{
    const videoPoster=thumbSrc?` poster="${escHtml(thumbSrc)}"`:'';
    const videoTile=vidSrc
      ?`<div class="card-media-item has-file" title="Play video" onclick="event.stopPropagation();openLightbox('vid',${jsArg(vidSrc)},${jsArg(c.name||'')})"><video class="card-video-preview" src="${escHtml(vidSrc)}"${videoPoster} preload="metadata" muted playsinline onloadedmetadata="try{if(this.currentTime===0)this.currentTime=0.1}catch(e){}"></video><div class="card-media-play" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px">▶</div><span class="card-media-caption">Video</span></div>`
      :`<div class="card-media-item" title="No video"><div class="card-media-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 8l6 4-6 4V8z" fill="currentColor" stroke="none"/></svg><span>Video</span></div></div>`;
    mediaSectionHtml=`<div class="card-media">${thumbTile}${videoTile}</div>`;
  }
  return`<div class="card" draggable="true" data-id="${escHtml(c.id)}">
    ${mediaSectionHtml}
    <div class="card-name">${escHtml(c.name)}</div>
    <div class="card-tags">
      <span class="tag ${catCls}">${escHtml(c.category)||'—'}</span>
      <span class="tag ${c.format==='Long'?'tag-long':'tag-short'}">${escHtml(c.format)||'Short'}</span>
      ${c.priority?`<span class="tag" style="background:#1a1a1a;color:${PRI_COLORS[c.priority]||'#888'}">${escHtml(c.priority)}</span>`:''}
      ${c.slidesCount?`<span class="tag" style="background:#1a2535;color:#7ab8e8;font-family:var(--mono)">${c.slidesCount} slides</span>`:''}
      ${dueSt==='overdue'?`<span class="tag" style="background:#3f1010;color:#f87171">Overdue</span>`:''}
      ${dueSt==='soon'?`<span class="tag" style="background:#3f2a0a;color:#e8a83b">Due soon</span>`:''}
    </div>
    <div class="card-meta">
      ${c.presenter?`<div class="meta-row"><span class="meta-k">Presenter</span><span class="meta-v">${escHtml(c.presenter)}</span></div>`:''}
      ${c.channel?`<div class="meta-row"><span class="meta-k">Channel</span><span class="meta-v">${escHtml(c.channel)}</span></div>`:''}
      ${c.postDate?`<div class="meta-row"><span class="meta-k">Post date</span><span class="meta-v">${escHtml(fmtDate(c.postDate))}</span></div>`:''}
      ${c.compliance?`<div class="meta-row"><span class="meta-k">Compliance</span><span class="meta-v ${c.compliance==='Approved'?'green':c.compliance==='Rejected'?'red':'amber'}">${escHtml(c.compliance)}</span></div>`:''}
      ${hasScript?`<div class="meta-row"><span class="meta-k">Script</span><span class="meta-v" style="color:#7ab8e8">✓ Added</span></div>`:''}
    </div>
    <hr class="card-hr">
    <div class="card-footer">
      <div style="display:flex;align-items:center;gap:7px">
        <div class="avatar-sm" style="background:${av}">${ini}</div>
        <span style="font-size:11px;color:var(--text3)">${escHtml(c.assign||c.presenter||'—')}</span>
      </div>
    </div>
  </div>`;
}

function sortCards(arr){
  const dir=sortDir==='asc'?1:-1;
  return arr.slice().sort((a,b)=>{
    let va,vb,missingLast=false;
    switch(sortBy){
      case'priority': va=PRI_ORDER[a.priority]??3; vb=PRI_ORDER[b.priority]??3; break;
      case'dueDate':  va=localDateKey(a.dueDate); vb=localDateKey(b.dueDate); missingLast=true; break;
      case'postDate': va=localDateKey(a.postDate); vb=localDateKey(b.postDate); missingLast=true; break;
      case'name':     va=(a.name||'').toLowerCase(); vb=(b.name||'').toLowerCase(); break;
      case'createdAt':va=dateTimeKey(a.createdAt); vb=dateTimeKey(b.createdAt); missingLast=true; break;
      default:        va=PRI_ORDER[a.priority]??3; vb=PRI_ORDER[b.priority]??3;
    }
    if(missingLast){
      if(!va&&vb)return 1;
      if(va&&!vb)return -1;
    }
    if(va<vb)return -1*dir; if(va>vb)return 1*dir;
    if(sortBy==='createdAt')return String(a.id||'').localeCompare(String(b.id||''))*dir;
    return 0;
  });
}

function renderAll(){
  const bw=document.querySelector('.board-wrap');
  const sx=bw?bw.scrollLeft:0;
  const fc=getFiltered();
  renderStats(fc);
  const postedIdx=currentStages().length-1;
  document.getElementById('board').innerHTML=currentStages().map((s,i)=>{
    const stageCards=i===postedIdx
      ?fc.filter(c=>c.stage===i).sort((a,b)=>(dateTimeKey(b.updatedAt)||0)-(dateTimeKey(a.updatedAt)||0))
      :sortCards(fc.filter(c=>c.stage===i));
    const expanded=expandedStages.has(i);
    const visibleCards=expanded?stageCards:stageCards.slice(0,CARD_COLLAPSE_LIMIT);
    const hiddenCount=stageCards.length-visibleCards.length;
    const toggleHtml=stageCards.length>CARD_COLLAPSE_LIMIT
      ?`<button class="show-more-btn" data-stage="${i}">${expanded?'Show less':`Show ${hiddenCount} more`}</button>`:'';
    return`<div class="col">
      <div class="col-head s${i}">
        <span class="col-name">${s}</span>
        <span class="col-count">${stageCards.length}</span>
      </div>
      <div class="cards" id="col-${i}">
        ${visibleCards.map(renderCard).join('')}
        ${toggleHtml}
        <button class="add-card-btn" data-stage="${i}">+ Add ${boardMode==='carousels'?'carousel':'video'}</button>
      </div>
    </div>`;
  }).join('');
  if(bw)bw.scrollLeft=sx;
  document.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click',()=>openEdit(el.dataset.id));
    el.addEventListener('dragstart',e=>{dragCardId=el.dataset.id;el.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
    el.addEventListener('dragend',()=>{el.classList.remove('dragging');document.querySelectorAll('.cards').forEach(c=>c.classList.remove('drag-over'));});
  });
  document.querySelectorAll('.cards').forEach(col=>{
    col.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';col.classList.add('drag-over');});
    col.addEventListener('dragleave',e=>{if(!col.contains(e.relatedTarget))col.classList.remove('drag-over');});
    col.addEventListener('drop',async e=>{
      e.preventDefault();col.classList.remove('drag-over');if(!dragCardId)return;
      const newStage=parseInt(col.id.replace('col-',''));
      const card=cards.find(c=>c.id===dragCardId);
      if(card&&card.stage!==newStage){
        const previousCard={...card,stageHistory:Array.isArray(card.stageHistory)?card.stageHistory.slice():[]};
        card.stage=newStage;
        applyStageAudit(card,previousCard);
        renderAll();
        try{await saveData();}catch(err){showToast('Save failed: '+err.message,'error');}
      }
      dragCardId=null;
    });
  });
  document.querySelectorAll('.add-card-btn').forEach(el=>{el.addEventListener('click',()=>openAdd(parseInt(el.dataset.stage)));});
  document.querySelectorAll('.show-more-btn').forEach(el=>{
    el.addEventListener('click',()=>{
      const stage=parseInt(el.dataset.stage);
      if(expandedStages.has(stage))expandedStages.delete(stage);else expandedStages.add(stage);
      renderAll();
    });
  });
}

// ========== MODAL ==========
function setPreview(type,url,name){
  const prev=document.getElementById(type+'Preview');if(!prev)return;
  const su=safeUrl(url);
  if(!su){prev.style.display='none';prev.innerHTML='';return;}
  if(type==='thumb'){prev.innerHTML=`<img src="${escHtml(su)}" onclick="openLightbox('img',${jsArg(su)},${jsArg(name||'')})" onerror="this.parentElement.style.display='none'">`;
  }else{prev.innerHTML=`<div class="upload-preview-vid" onclick="openLightbox('vid',${jsArg(su)},${jsArg(name||'')})"><span style="font-size:22px">▶</span><span>Preview video</span></div>`;}
  prev.style.display='block';
}

function resetModal(){
  transferGen++; // invalidate any in-flight upload/download callbacks
  activeUploadPromises = new Set(); // abandon upload tracking for this modal session
  modalUploadedItems = new Set();
  pendingFileDeletes = new Set();
  const isCarousel=boardMode==='carousels';
  thumbFileUrl=null;vidFileUrl=null;
  thumbItemId=null;vidItemId=null;
  thumbDisplayUrl=null;vidDisplayUrl=null;
  carouselImages=[];
  ['fName','fChannel','fSegment','fSeoTitle','fNotes','fPostDate','fDueDate','fSlidesCount'].forEach(id=>document.getElementById(id).value='');
  ['fScript','fSeoDesc'].forEach(id=>{const el=document.getElementById(id);el.value='';el.style.height='auto';});
  document.getElementById('slidesCountField').style.display=isCarousel?'flex':'none';
  document.getElementById('vidUploadField').style.display=isCarousel?'none':'block';
  document.getElementById('thumbUploadField').style.display=isCarousel?'none':'block';
  document.getElementById('carouselImagesField').style.display=isCarousel?'block':'none';
  if(isCarousel){renderCarouselImagesGrid();document.getElementById('carouselImagesStatus').textContent='';document.getElementById('carouselDownloadAll').style.display='none';}
  // Populate stage options based on board mode
  const stageEl=document.getElementById('fStage');
  stageEl.innerHTML=currentStages().map((s,i)=>`<option value="${i}">${s}</option>`).join('');
  ['fFormat','fCategory','fPresenter','fAssign','fEditor','fPriority','fCompliance','fApprove','fStage'].forEach(id=>{const el=document.getElementById(id);if(el.options[0])el.selectedIndex=0;});
  document.getElementById('fFormat').value='Short';
  const firstCat=categoriesForOptions()[0]||'';
  if(firstCat)document.getElementById('fCategory').value=firstCat;
  ['thumbStatus','vidStatus','thumbLink','vidLink'].forEach(id=>document.getElementById(id).textContent='');
  document.getElementById('thumbLabel').textContent='Upload image';
  document.getElementById('vidLabel').textContent='Upload video';
  document.getElementById('thumbActions').style.display='none';
  document.getElementById('vidActions').style.display='none';
  document.getElementById('fNameError').textContent='';
  document.getElementById('fNameLabel').firstChild.textContent=isCarousel?'Carousel name ':'Video name ';
  ['thumbPreview','vidPreview'].forEach(id=>{const el=document.getElementById(id);el.style.display='none';el.innerHTML='';});
}

function trackUploadPromise(promise){
  activeUploadPromises.add(promise);
  promise.finally(()=>activeUploadPromises.delete(promise));
  return promise;
}

async function waitForActiveUploads(){
  const uploads=[...activeUploadPromises];
  if(uploads.length)await Promise.allSettled(uploads);
}

function rememberUploadedItem(itemId){
  if(itemId)modalUploadedItems.add(itemId);
}

function scheduleExistingFileDelete(itemId){
  if(itemId)pendingFileDeletes.add(itemId);
}

function cardFileItemIds(card){
  const ids=[card?.thumbItemId,card?.vidItemId];
  if(Array.isArray(card?.images))card.images.forEach(img=>ids.push(img?.itemId));
  return ids.filter(Boolean);
}

async function deleteStorageItems(itemIds){
  const ids=[...new Set([...itemIds].filter(Boolean))];
  await Promise.allSettled(ids.map(id=>firebaseDeleteFile(id)));
}

async function cleanupAbandonedModalFiles(){
  await deleteStorageItems(modalUploadedItems);
  modalUploadedItems.clear();
}

async function finalizeSavedModalFiles(){
  await deleteStorageItems(pendingFileDeletes);
  pendingFileDeletes.clear();
  modalUploadedItems.clear();
}

function openAdd(stage){
  editId=null;resetModal();
  document.getElementById('fStage').value=stage||0;
  document.getElementById('modalTitle').textContent=boardMode==='carousels'?'New carousel':'New video';
  document.getElementById('deleteBtn').style.display='none';
  document.getElementById('modalBg').classList.add('open');
}

function openEdit(id){
  const c=cards.find(x=>x.id===id);if(!c)return;
  editId=id;resetModal();
  thumbFileUrl=c.thumbUrl||null;vidFileUrl=c.vidUrl||null;
  document.getElementById('modalTitle').textContent=boardMode==='carousels'?'Edit carousel':'Edit video';
  document.getElementById('deleteBtn').style.display='';
  document.getElementById('fName').value=c.name||'';
  document.getElementById('fFormat').value=c.format||'Short';
  document.getElementById('fCategory').value=c.category||'';
  document.getElementById('fPresenter').value=c.presenter||'';
  document.getElementById('fAssign').value=c.assign||'';
  document.getElementById('fEditor').value=c.editor||'';
  document.getElementById('fPriority').value=c.priority||'';
  document.getElementById('fPostDate').value=c.postDate||'';
  document.getElementById('fDueDate').value=c.dueDate||'';
  document.getElementById('fChannel').value=c.channel||'';
  document.getElementById('fSegment').value=c.segment||'';
  document.getElementById('fScript').value=c.script||'';
  document.getElementById('fSeoTitle').value=c.seoTitle||'';
  document.getElementById('fSeoDesc').value=c.seoDesc||'';
  document.getElementById('fNotes').value=c.notes||'';
  document.getElementById('fCompliance').value=c.compliance||'';
  document.getElementById('fApprove').value=c.approve||'';
  document.getElementById('fStage').value=c.stage||0;
  document.getElementById('fSlidesCount').value=c.slidesCount||'';
  if(boardMode==='carousels'&&Array.isArray(c.images)&&c.images.length){
    carouselImages=c.images.map(img=>({shareUrl:img.shareUrl,itemId:img.itemId||null,downloadUrl:img.downloadUrl||img.shareUrl}));
    renderCarouselImagesGrid();
    document.getElementById('carouselImagesStatus').textContent=`${carouselImages.length} image${carouselImages.length>1?'s':''} uploaded ✓`;
  }
  if(c.thumbUrl){
    thumbItemId=c.thumbItemId||null;thumbDisplayUrl=c.thumbDisplayUrl||c.thumbUrl||null;
    document.getElementById('thumbStatus').textContent='File uploaded ✓';
    document.getElementById('thumbLabel').textContent='Change image';
    document.getElementById('thumbLink').innerHTML='';
    document.getElementById('thumbActions').style.display='flex';
    setPreview('thumb',thumbDisplayUrl,c.name);
  }
  if(c.vidUrl){
    vidItemId=c.vidItemId||null;vidDisplayUrl=c.vidDisplayUrl||c.vidUrl||null;
    document.getElementById('vidStatus').textContent='File uploaded ✓';
    document.getElementById('vidLabel').textContent='Change video';
    document.getElementById('vidLink').innerHTML='';
    document.getElementById('vidActions').style.display='flex';
    setPreview('vid',vidDisplayUrl,c.name);
  }
  document.getElementById('modalBg').classList.add('open');
  requestAnimationFrame(()=>{
    document.querySelectorAll('#modalBg textarea.auto-expand').forEach(el=>{
      el.style.height='auto';
      el.style.height=el.scrollHeight+'px';
    });
  });
}

function closeModal({saved=false}={}){
  document.getElementById('modalBg').classList.remove('open');
  if(!saved){
    transferGen++;
    cleanupAbandonedModalFiles().catch(()=>{});
  }
  setTimeout(flushPendingSnapshot,0);
}

async function handleUpload(file,type){
  const gen=transferGen;
  const statusEl=document.getElementById(type+'Status');
  const boxEl=document.getElementById(type+'Box');
  const linkEl=document.getElementById(type+'Link');
  let settle;
  trackUploadPromise(new Promise(r=>{settle=r;}));
  setTransferStatus(statusEl,'Uploading',0);
  boxEl.classList.add('uploading');
  try{
    const result=await uploadFileWithProgress(file,type==='thumb'?'thumbnails':'videos',pct=>{if(transferGen===gen)setTransferStatus(statusEl,'Uploading',pct);});
    if(transferGen!==gen){
      if(result.itemId)firebaseDeleteFile(result.itemId).catch(()=>{});
      boxEl.classList.remove('uploading');settle();return;
    }
    rememberUploadedItem(result.itemId);
    if(type==='thumb'){
      scheduleExistingFileDelete(thumbItemId);
      thumbFileUrl=result.shareUrl;thumbItemId=result.itemId;thumbDisplayUrl=result.downloadUrl;
    }
    else{
      scheduleExistingFileDelete(vidItemId);
      vidFileUrl=result.shareUrl;vidItemId=result.itemId;vidDisplayUrl=result.downloadUrl;
    }
    setPlainStatus(statusEl,'Uploaded ✓');
    linkEl.innerHTML='';
    document.getElementById(type+'Actions').style.display='flex';
    setPreview(type,type==='thumb'?thumbDisplayUrl:vidDisplayUrl,document.getElementById('fName').value||'');
    showToast(`File uploaded to Firebase`,'success');
  }catch(e){if(transferGen===gen){setPlainStatus(statusEl,'Upload failed: '+e.message,'error');showToast('Upload failed','error');}}
  boxEl.classList.remove('uploading');
  settle();
}

async function downloadUpload(type){
  const statusEl=document.getElementById(type+'Status');
  const itemId = type==='thumb' ? thumbItemId : vidItemId;
  const cachedUrl = type==='thumb' ? thumbDisplayUrl : vidDisplayUrl;
  if(!itemId && !cachedUrl){showToast('No file to download','error');return;}
  // Always fetch a fresh pre-auth URL — cached ones expire after ~1 hour
  let url = cachedUrl;
  if(itemId){
    try{
      url=await firebaseRefreshDownloadUrl(itemId);
      if(type==='thumb') thumbDisplayUrl=url; else vidDisplayUrl=url;
    }catch(e){}
    // Make sure the file is served with Content-Disposition: attachment so the
    // browser saves it straight to disk instead of opening/previewing it. New
    // uploads get this set at upload time; this patches older files that were
    // uploaded before that existed, so the "instant download" behavior applies
    // to everything, not just new files. Best-effort — if it fails (e.g. an
    // older/cached token without write scope) we still fall through to opening
    // the file, same as before.
    try{
      const cleanName=String(itemId).split('/').pop().replace(/^\d+_[a-z0-9]+_/i,'')||'file';
      await firebaseStorage.ref(itemId).updateMetadata({contentDisposition:`attachment; filename="${cleanName}"`});
    }catch(e){}
  }
  if(!url){showToast('No file to download','error');return;}
  const cleanName=itemId
    ?String(itemId).split('/').pop().replace(/^\d+_[a-z0-9]+_/i,'')||'file'
    :'file';
  // Best approach for forcing video (and all file) downloads:
  //   fetch → blob → blob URL → <a download> click.
  // A blob: URL is same-origin, so browsers can't ignore the `download`
  // attribute (they only ignore it for cross-origin hrefs). This bypasses
  // the browser's media-player decision for videos entirely.
  // If fetch is blocked (ad-blocker / VPN / network error), we fall back
  // to a plain link click with target=_blank — at least the board page
  // isn't destroyed, and Content-Disposition:attachment on the Storage URL
  // should still trigger a save dialog in most browsers.
  try{
    setPlainStatus(statusEl,'Downloading…');
    const resp=await fetch(url);
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const blob=await resp.blob();
    const blobUrl=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=blobUrl;a.download=cleanName;a.style.display='none';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(blobUrl),60000);
    setPlainStatus(statusEl,'Download started — check your browser\'s downloads.');
    showToast('Download started','success');
  }catch(e){
    // fetch blocked or failed — open in a new tab; Content-Disposition:
    // attachment (set above via updateMetadata) should trigger a save dialog.
    const a=document.createElement('a');
    a.href=url;a.download=cleanName;a.target='_blank';a.rel='noopener';
    a.style.display='none';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setPlainStatus(statusEl,'Download started — check your browser\'s downloads.');
    showToast('Download started','success');
  }
}

async function removeUpload(type){
  const label = type==='thumb' ? 'thumbnail image' : 'video';
  if(!confirm(`Remove the uploaded ${label} from this card? The file is deleted from Firebase only after you save.`)) return;
  const itemId = type==='thumb' ? thumbItemId : vidItemId;
  scheduleExistingFileDelete(itemId);
  if(type==='thumb'){
    thumbFileUrl=null;thumbItemId=null;thumbDisplayUrl=null;
    document.getElementById('thumbStatus').textContent='';
    document.getElementById('thumbLabel').textContent='Upload image';
    document.getElementById('thumbLink').innerHTML='';
    document.getElementById('thumbActions').style.display='none';
    const p=document.getElementById('thumbPreview');p.style.display='none';p.innerHTML='';
  }else{
    vidFileUrl=null;vidItemId=null;vidDisplayUrl=null;
    document.getElementById('vidStatus').textContent='';
    document.getElementById('vidLabel').textContent='Upload video';
    document.getElementById('vidLink').innerHTML='';
    document.getElementById('vidActions').style.display='none';
    const p=document.getElementById('vidPreview');p.style.display='none';p.innerHTML='';
  }
  showToast(`File will be removed after saving`,'success');
}

function renderCarouselImagesGrid(){
  const grid=document.getElementById('carouselImagesGrid');
  const count=document.getElementById('carouselImageCount');
  if(!grid)return;
  count.textContent=carouselImages.length?`(${carouselImages.length})` :'';
  const dlBtn=document.getElementById('carouselDownloadAll');
  if(dlBtn) dlBtn.style.display=carouselImages.length?'block':'none';
  grid.innerHTML=carouselImages.map((img,i)=>{
    const src=escHtml(safeUrl(img.downloadUrl||img.shareUrl)||'');
    return `<div class="carousel-img-thumb">
      <img src="${src}" onclick="openLightbox('img',${jsArg(img.downloadUrl||img.shareUrl)},${jsArg('Slide '+(i+1))})" onerror="this.parentElement.style.opacity='0.4'">
      <span class="ci-num">${i+1}</span>
      <span class="ci-remove" onclick="removeCarouselImage(${i})" title="Remove">✕</span>
    </div>`;
  }).join('');
}

function removeCarouselImage(idx){
  const removed=carouselImages.splice(idx,1)[0];
  scheduleExistingFileDelete(removed?.itemId);
  renderCarouselImagesGrid();
}

async function downloadAllCarouselImages(){
  if(!carouselImages.length) return;
  const gen=transferGen;
  const statusEl=document.getElementById('carouselImagesStatus');
  const btn=document.getElementById('carouselDownloadAll');
  if(btn)btn.disabled=true;
  setTransferStatus(statusEl,`Downloading 0/${carouselImages.length}`,0);
  let failed=false;
  for(let i=0;i<carouselImages.length;i++){
    const img=carouselImages[i];
    // Fetch fresh pre-auth URL to avoid 1-hour expiry error on SharePoint
    let url=img.downloadUrl||img.shareUrl;
    if(img.itemId){
      try{url=await firebaseRefreshDownloadUrl(img.itemId);img.downloadUrl=url;}catch(e){}
    }
    if(!url) continue;
    try{
      const blob=await fetchBlobWithProgress(url,pct=>{
        if(transferGen!==gen)return;
        const base=Math.round((i/carouselImages.length)*100);
        const part=typeof pct==='number'?Math.round(pct/carouselImages.length):0;
        setTransferStatus(statusEl,`Downloading ${i+1}/${carouselImages.length}`,Math.min(100,base+part));
      });
      if(transferGen!==gen)return;
      triggerBlobDownload(blob,`slide-${i+1}`);
      if(i<carouselImages.length-1) await new Promise(r=>setTimeout(r,300));
    }catch(e){
      failed=true;
      if(transferGen===gen)setPlainStatus(statusEl,`Download failed on slide ${i+1}: ${e.message}`,'error');
      break;
    }
  }
  if(btn)btn.disabled=false;
  if(failed)return;
  if(transferGen===gen)setPlainStatus(statusEl,`Download started for ${carouselImages.length} image${carouselImages.length>1?'s':''} ✓`);
  showToast(`Download started for ${carouselImages.length} image${carouselImages.length>1?'s':''}...`,'success');
}

async function handleCarouselImagesUpload(files){
  const gen=transferGen;
  const statusEl=document.getElementById('carouselImagesStatus');
  const boxEl=document.getElementById('carouselAddImgBox');
  const total=files.length;
  let settle;
  trackUploadPromise(new Promise(r=>{settle=r;}));
  setTransferStatus(statusEl,`Uploading 0/${total}`,0);
  boxEl.classList.add('uploading');
  let done=0;
  for(const file of files){
    if(transferGen!==gen){boxEl.classList.remove('uploading');settle();return;}
    try{
      const result=await uploadFileWithProgress(file,'thumbnails',pct=>{
        if(transferGen!==gen)return;
        const base=Math.round((done/total)*100);
        const part=typeof pct==='number'?Math.round(pct/total):0;
        setTransferStatus(statusEl,`Uploading ${done+1}/${total}`,Math.min(100,base+part));
      });
      if(transferGen!==gen){
        if(result.itemId)firebaseDeleteFile(result.itemId).catch(()=>{});
        boxEl.classList.remove('uploading');settle();return;
      }
      rememberUploadedItem(result.itemId);
      carouselImages.push({shareUrl:result.shareUrl,itemId:result.itemId,downloadUrl:result.downloadUrl});
      done++;
      if(done<total)setTransferStatus(statusEl,`Uploading ${done}/${total}`,Math.round((done/total)*100));
      else setPlainStatus(statusEl,`${done} image${done>1?'s':''} uploaded ✓`);
      renderCarouselImagesGrid();
    }catch(e){
      if(transferGen===gen)setPlainStatus(statusEl,`Failed on "${file.name}": ${e.message}`,'error');
    }
  }
  boxEl.classList.remove('uploading');
  settle();
}

// ========== LIGHTBOX ==========
function openLightbox(type,url,name){
  const content=document.getElementById('lightboxContent');
  const label=document.getElementById('lightboxLabel');
  const safeU=escHtml(safeUrl(url));
  if(type==='img'){content.innerHTML=`<img class="lightbox-img" src="${safeU}" alt="${escHtml(name)}">`;}
  else{content.innerHTML=`<video class="lightbox-video" src="${safeU}" controls autoplay></video>`;}
  label.textContent=name;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox(){document.getElementById('lightbox').classList.remove('open');document.getElementById('lightboxContent').innerHTML='';}

// ========== UNDO DELETE ==========
// onUndo: optional async callback invoked when the user clicks Undo.
// If omitted, falls back to the old pendingDelete-based soft-undo.
function showToastUndo(msg,onUndo){
  const t=document.getElementById('toast');t.innerHTML='';
  const span=document.createElement('span');span.textContent=msg;
  const btn=document.createElement('button');btn.textContent='Undo';
  btn.style.cssText='margin-left:12px;background:none;border:1px solid currentColor;border-radius:4px;padding:2px 8px;font-size:12px;color:inherit;cursor:pointer;font-family:inherit';
  let used=false;
  btn.addEventListener('click',async()=>{
    if(used)return;used=true;
    t.classList.remove('show');
    if(onUndo){
      await onUndo();
    }else if(pendingDelete){
      clearTimeout(pendingDelete.timer);
      cards.splice(pendingDelete.index,0,pendingDelete.card);
      pendingDelete=null;
      renderAll();
      try{await saveData();}catch(e){showToast('Undo save failed: '+e.message,'error');}finally{flushPendingSnapshot();}
    }
  });
  const bar=document.createElement('div');bar.className='toast-bar';
  t.appendChild(span);t.appendChild(btn);t.appendChild(bar);
  t.className='toast show';
  setTimeout(()=>t.classList.remove('show'),5000);
}

// ========== REPORTS ==========
let reportPeriod = 'month';
let reportTab = 'board';
let platformReportAccountId = 'ig_news';
let platformReportLoading = false;
let platformReportData = null;
let platformTopContentLoading = false;
let platformTopContentMode = null;

function numFmt(n){
  if(n==null||Number.isNaN(Number(n)))return'—';
  return Number(n||0).toLocaleString('en-US');
}

function reportPeriodLabel(){
  const {from, to} = getReportRange();
  if(reportPeriod==='today')return'Today';
  if(reportPeriod==='week')return'This week';
  if(reportPeriod==='month')return'This month';
  return (from||'?')+' → '+(to||'?');
}

function getReportRange() {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  if (reportPeriod === 'today') { const t = fmt(now); return {from:t, to:t}; }
  if (reportPeriod === 'week') {
    const day = now.getDay(); // 0=Sun
    const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return {from:fmt(mon), to:fmt(sun)};
  }
  if (reportPeriod === 'month') {
    const from = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
    const to = fmt(new Date(now.getFullYear(), now.getMonth()+1, 0));
    return {from, to};
  }
  if (reportPeriod === 'custom') {
    return {from: document.getElementById('reportFromDate').value||'', to: document.getElementById('reportToDate').value||''};
  }
  const from = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = fmt(new Date(now.getFullYear(), now.getMonth()+1, 0));
  return {from, to};
}

function localDateStr(isoStr) {
  return localDateKey(isoStr);
}

function reportScopeDate(c){
  const postedIdx=currentStages().length-1;
  if(c.stage===postedIdx&&c.postedAt)return localDateStr(c.postedAt);
  return localDateKey(c.postDate)||localDateStr(c.createdAt);
}

function filterCardsByPeriod(from, to) {
  if (!from && !to) return cards;
  return cards.filter(c => {
    const scopeDate = reportScopeDate(c);
    if (!scopeDate) return false;
    if (from && scopeDate < from) return false;
    if (to   && scopeDate > to)   return false;
    return true;
  });
}

function barColor(label) {
  const map = {High:'#f87171',Medium:'#e8a83b',Low:'#5ae8a0',Approved:'#5ae8a0',Pending:'#e8a83b',Rejected:'#f87171',Short:'#7ab8e8',Long:'#e8a07a',Overdue:'#f87171','Due soon':'#e8a83b','On-time':'#5ae8a0'};
  return map[label] || 'var(--blue)';
}

function renderBars(items, max) {
  if (!items.length) return '<div class="widget-empty">No data</div>';
  return items.map(({label, count}) => {
    const pct = max > 0 ? Math.round(count/max*100) : 0;
    return `<div class="rbar-row">
      <span class="rbar-label" title="${escHtml(label)}">${escHtml(label)}</span>
      <div class="rbar-track"><div class="rbar-fill" style="width:${pct}%;background:${barColor(label)}"></div></div>
      <span class="rbar-count">${count}</span>
      <span class="rbar-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function computeReport() {
  const {from, to} = getReportRange();
  const scopeCards = filterCardsByPeriod(from, to);
  const total = scopeCards.length;
  const grouped = (arr, key, labels) => {
    const vals = labels || [...new Set(arr.map(c=>c[key]).filter(Boolean))];
    return vals.map(v=>({label:v, count:arr.filter(c=>c[key]===v).length})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count);
  };
  const byStage    = currentStages().map((s,i)=>({label:s, count:scopeCards.filter(c=>c.stage===i).length})).filter(x=>x.count>0);
  const byFormat   = grouped(scopeCards,'format',['Short','Long']);
  const byCategory = grouped(scopeCards,'category');
  const byPresenter= grouped(scopeCards,'presenter');
  const byAssign   = grouped(scopeCards,'assign');
  const byEditor   = grouped(scopeCards,'editor');
  const byPriority = grouped(scopeCards,'priority',['High','Medium','Low']);
  const byCompliance=grouped(scopeCards,'compliance',['Approved','Pending','Rejected']);
  const postedIdx = currentStages().length-1;
  const active = scopeCards.filter(c=>c.stage<postedIdx);
  const dueItems = [
    {label:'Overdue',  count: active.filter(c=>dueDateStatus(c.dueDate,c.stage)==='overdue').length},
    {label:'Due soon', count: active.filter(c=>dueDateStatus(c.dueDate,c.stage)==='soon').length},
    {label:'On-time',  count: active.filter(c=>c.dueDate&&dueDateStatus(c.dueDate,c.stage)===null).length},
  ].filter(x=>x.count>0);
  const withThumb = scopeCards.filter(c=>c.thumbUrl).length;
  const withVid   = boardMode==='carousels'
    ? scopeCards.filter(c=>Array.isArray(c.images)&&c.images.length>0).length
    : scopeCards.filter(c=>c.vidUrl).length;
  const withVidLabel = boardMode==='carousels' ? 'Has Images' : 'Has Video';
  return {total, from, to, scopeCards, byStage, byFormat, byCategory, byPresenter, byAssign, byEditor, byPriority, byCompliance, dueItems, withThumb, withVid, withVidLabel};
}

function renderBoardReport() {
  const r = computeReport();
  const periodLabel = reportPeriodLabel();
  const tot = r.total || 1;

  document.getElementById('reportsBody').innerHTML = `
    <div class="report-period-note">
      <span style="color:var(--text2);font-weight:500">${boardMode==='carousels'?'Carousels':'Videos'}</span>
      &nbsp;·&nbsp; Period: <strong style="color:var(--text)">${escHtml(periodLabel)}</strong>
      &nbsp;·&nbsp; ${r.total} ${boardMode==='carousels'?'carousel':'video'}${r.total!==1?'s':''} in scope
      &nbsp;·&nbsp; Date basis: posted timestamp, then planned post date, then created date
    </div>

    <div class="report-section-title">Overview</div>
    <div class="report-summary-grid">
      <div class="summary-card"><div class="summary-num">${r.total}</div><div class="summary-sub">Total</div></div>
      ${r.byStage.filter(s=>s.count>0).map(s=>`<div class="summary-card"><div class="summary-num">${s.count}</div><div class="summary-sub">${escHtml(s.label)}</div></div>`).join('')}
      <div class="summary-card"><div class="summary-num">${r.withThumb}</div><div class="summary-sub">${boardMode==='carousels'?'Has Cover':'Has Thumb'}</div></div>
      <div class="summary-card"><div class="summary-num">${r.withVid}</div><div class="summary-sub">${r.withVidLabel}</div></div>
    </div>

    <div class="report-section-title">Breakdown</div>
    <div class="report-grid">
      <div class="report-widget"><div class="widget-title">By Stage</div>${renderBars(r.byStage, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Format</div>${renderBars(r.byFormat, tot)}</div>
      <div class="report-widget"><div class="widget-title">Due Status</div>${renderBars(r.dueItems, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Category</div>${renderBars(r.byCategory, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Priority</div>${renderBars(r.byPriority, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Compliance</div>${renderBars(r.byCompliance, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Presenter</div>${renderBars(r.byPresenter, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Assigned</div>${renderBars(r.byAssign, tot)}</div>
      <div class="report-widget"><div class="widget-title">By Editor</div>${renderBars(r.byEditor, tot)}</div>
    </div>`;
}

function setupReportsHeader(){
  const isAdmin=canManageSettings();
  const platformTab=document.getElementById('platformReportTabBtn');
  const platformSelect=document.getElementById('platformReportAccount');
  platformTab.style.display=isAdmin?'':'none';
  if(!isAdmin&&reportTab==='platforms')reportTab='board';
  document.querySelectorAll('.report-tab').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.reportTab===reportTab);
  });
  platformSelect.style.display=reportTab==='platforms'&&isAdmin?'':'none';
  platformSelect.innerHTML=POSTING_ACCOUNTS.map(a=>`<option value="${escHtml(a.id)}">${escHtml(a.label)}</option>`).join('');
  platformSelect.value=platformReportAccountId;
}

function renderMetricCard(icon,label,value){
  return`<div class="platform-metric-card">
    <div class="platform-metric-head"><span class="platform-metric-icon">${icon}</span><span class="platform-metric-label">${escHtml(label)}</span></div>
    <div class="platform-metric-value">${numFmt(value)}</div>
  </div>`;
}

function renderPlatformInsightBars(totals){
  const items=[
    ['Views',totals.views],
    ['Reach',totals.reach],
    ['Engagement',totals.totalInteractions],
    ['Likes',totals.likes],
    ['Comments',totals.comments],
    ['Saves',totals.saves],
    ['Shares',totals.shares]
  ].filter(([,value])=>value!=null&&Number(value)>0);
  if(!items.length)return'<div class="widget-empty">No chartable metrics returned for this period.</div>';
  const max=Math.max(...items.map(([,value])=>Number(value)||0),1);
  return items.map(([label,value])=>{
    const pct=Math.max(3,Math.round((Number(value)||0)/max*100));
    return`<div class="platform-chart-row">
      <div class="platform-chart-label">${escHtml(label)}</div>
      <div class="platform-chart-track"><div class="platform-chart-fill" style="width:${pct}%"></div></div>
      <div class="platform-chart-value">${numFmt(value)}</div>
    </div>`;
  }).join('');
}

function renderPlatformReportSkeleton(message='Loading platform report...'){
  document.getElementById('reportsBody').innerHTML=`<div class="platform-report-empty">${escHtml(message)}</div>`;
}

function renderPlatformReport(){
  const account=POSTING_ACCOUNTS.find(a=>a.id===platformReportAccountId)||POSTING_ACCOUNTS[0];
  if(platformReportLoading){
    renderPlatformReportSkeleton('Loading platform analytics...');
    return;
  }
  if(!platformReportData){
    renderPlatformReportSkeleton('Choose a platform account to load analytics.');
    return;
  }
  if(!platformReportData.ok){
    document.getElementById('reportsBody').innerHTML=`
      <div class="report-period-note">
        <span style="color:var(--text2);font-weight:500">${escHtml(account.label)}</span>
        &nbsp;·&nbsp; Period: <strong style="color:var(--text)">${escHtml(reportPeriodLabel())}</strong>
      </div>
      <div class="platform-report-empty">${escHtml(platformReportData.reason||'This platform is not connected yet.')}</div>`;
    return;
  }

  const totals=platformReportData.totals||{};
  const rows=Array.isArray(platformReportData.rows)?platformReportData.rows:[];
  const topMode=platformReportData.contentType||platformTopContentMode||'all';
  document.getElementById('reportsBody').innerHTML=`
    <div class="report-period-note">
      <span style="color:var(--text2);font-weight:500">${escHtml(account.label)}</span>
      &nbsp;·&nbsp; Period: <strong style="color:var(--text)">${escHtml(reportPeriodLabel())}</strong>
      &nbsp;·&nbsp; Overview source: ${platformReportData.overviewSource==='account_insights'?'Meta account insights':escHtml(account.platform+' API')}
    </div>

    <div class="report-section-title">Overview</div>
    <div class="platform-report-layout">
      <div class="platform-overview-grid">
        ${renderMetricCard('Views','Views',totals.views)}
        ${renderMetricCard('Impressions','Impressions',totals.impressions)}
        ${renderMetricCard('Reach','Reach',totals.reach)}
        ${renderMetricCard('Engagement','Engagement',totals.totalInteractions)}
        ${renderMetricCard('Likes','Likes',totals.likes)}
        ${renderMetricCard('Comments','Comments',totals.comments)}
        ${renderMetricCard('Saves','Saves',totals.saves)}
        ${renderMetricCard('Shares','Shares',totals.shares)}
        ${renderMetricCard('Content','Published content',totals.publishedContent)}
      </div>
      <div class="platform-chart-card">
        <div class="widget-title">Performance distribution</div>
        ${renderPlatformInsightBars(totals)}
      </div>
    </div>

    <div class="report-section-title">Top 10 Content</div>
    <div class="top-content-toolbar">
      <span class="report-period-note" style="margin-bottom:0">Optional content-level ranking. Overview totals above do not depend on this table.</span>
      <div class="top-content-actions">
        <button class="btn top-content-btn ${topMode==='all'&&rows.length?'active':''}" data-content-type="all">${platformTopContentLoading&&platformTopContentMode==='all'?'Loading...':'Show top 10 all content'}</button>
        <button class="btn top-content-btn ${topMode==='reels'&&rows.length?'active':''}" data-content-type="reels">${platformTopContentLoading&&platformTopContentMode==='reels'?'Loading...':'Reels'}</button>
        <button class="btn top-content-btn ${topMode==='posts'&&rows.length?'active':''}" data-content-type="posts">${platformTopContentLoading&&platformTopContentMode==='posts'?'Loading...':'Posts'}</button>
      </div>
    </div>
    ${platformTopContentLoading?'<div class="platform-report-empty">Loading top content...</div>':(platformReportData.topContentLoaded&&rows.length?`<div class="report-table-wrap">
      <table class="report-table">
        <thead><tr>
          <th>#</th><th>Content</th><th>Type</th><th>Published</th><th>Views</th><th>Impressions</th><th>Likes</th><th>Comments</th><th>Saves</th><th>Shares</th><th>Engagement</th><th>Link</th>
        </tr></thead>
        <tbody>
          ${rows.map((row,i)=>`<tr>
            <td>${i+1}</td>
            <td class="platform-content-cell" title="${escHtml(row.title||'Untitled')}">${escHtml(row.title||'Untitled')}${row.error?`<div style="color:#f87171;font-size:10px;margin-top:3px">${escHtml(row.error)}</div>`:''}</td>
            <td>${escHtml(row.mediaType||'-')}</td>
            <td>${escHtml(row.publishedAt?localDateKey(row.publishedAt):'-')}</td>
            <td>${numFmt(row.views)}</td>
            <td>${numFmt(row.impressions)}</td>
            <td>${numFmt(row.likes)}</td>
            <td>${numFmt(row.comments)}</td>
            <td>${numFmt(row.saves)}</td>
            <td>${numFmt(row.shares)}</td>
            <td>${numFmt(row.totalInteractions)}</td>
            <td>${row.permalink?`<a href="${escHtml(row.permalink)}" target="_blank" rel="noopener">Open</a>`:'-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`:(platformReportData.topContentLoaded?'<div class="platform-report-empty">No published content found for this selection.</div>':'<div class="platform-report-empty">Top 10 is not loaded yet. Choose all content, Reels, or Posts when you need the ranking.</div>'))}`;
  document.querySelectorAll('.top-content-btn').forEach(btn=>{
    btn.addEventListener('click',()=>loadPlatformTopContent(btn.dataset.contentType));
  });
}

async function loadPlatformReport(){
  if(reportTab!=='platforms')return;
  if(!firebaseFunctions){
    platformReportData={ok:false,reason:'Firebase Functions SDK is not loaded. Refresh and retry.'};
    renderPlatformReport();
    return;
  }
  const {from,to}=getReportRange();
  platformReportLoading=true;
  platformReportData=null;
  renderPlatformReport();
  try{
    const fn=firebaseFunctions.httpsCallable('getPlatformReport');
    const res=await fn({accountId:platformReportAccountId,from,to,includeTopContent:false});
    platformReportData=res.data||{ok:false,reason:'No report data returned.'};
  }catch(e){
    platformReportData={ok:false,reason:e?.message||String(e)};
  }finally{
    platformReportLoading=false;
    renderPlatformReport();
  }
}

async function loadPlatformTopContent(contentType='all'){
  if(reportTab!=='platforms'||!firebaseFunctions||!platformReportData?.ok)return;
  const {from,to}=getReportRange();
  platformTopContentLoading=true;
  platformTopContentMode=contentType;
  renderPlatformReport();
  try{
    const fn=firebaseFunctions.httpsCallable('getPlatformReport');
    const res=await fn({accountId:platformReportAccountId,from,to,includeTopContent:true,contentType});
    const next=res.data||{};
    platformReportData={
      ...platformReportData,
      ...next,
      totals:platformReportData.totals,
      overviewSource:platformReportData.overviewSource
    };
  }catch(e){
    showToast('Top content load failed: '+(e?.message||String(e)),'error');
  }finally{
    platformTopContentLoading=false;
    renderPlatformReport();
  }
}

function renderReport(){
  setupReportsHeader();
  if(reportTab==='platforms'){
    renderPlatformReport();
    if(!platformReportLoading&&!platformReportData)loadPlatformReport();
    return;
  }
  renderBoardReport();
}

function openReports() {
  document.getElementById('reportsOverlay').classList.add('open');
  setupReportsHeader();
  renderReport();
}
function closeReports() { document.getElementById('reportsOverlay').classList.remove('open'); }

function exportCSV() {
  if(reportTab==='platforms'){
    const rows=Array.isArray(platformReportData?.rows)?platformReportData.rows:[];
    const headers=['Rank','Content','Type','Published','Views','Impressions','Likes','Comments','Saves','Shares','Engagement','Permalink'];
    const csvRows=rows.map((row,i)=>[
      i+1,row.title,row.mediaType,row.publishedAt?localDateKey(row.publishedAt):'',row.views,row.impressions,row.likes,row.comments,row.saves,row.shares,row.totalInteractions,row.permalink
    ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`));
    const csv=[headers.map(h=>`"${h}"`),...csvRows].map(r=>r.join(',')).join('\n');
    const url=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a');a.href=url;a.download='socieva-platform-report.csv';a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const r = computeReport();
  const headers = ['Name','Format','Category','Stage','Presenter','Assigned','Editor','Priority','Post Date','Due Date','Channel','Segment','Compliance','Approved By','Has Thumbnail',boardMode==='carousels'?'Has Images':'Has Video','Has Script','SEO Title','SEO Description','Notes'];
  const rows = r.scopeCards.map(c => [
    c.name, c.format, c.category, currentStages()[c.stage]||'',
    c.presenter, c.assign, c.editor, c.priority,
    c.postDate, c.dueDate, c.channel, c.segment,
    c.compliance, c.approve,
    c.thumbUrl ? 'Yes' : 'No',
    boardMode==='carousels' ? (Array.isArray(c.images)&&c.images.length?'Yes':'No') : (c.vidUrl?'Yes':'No'),
    (c.script&&c.script.trim()) ? 'Yes' : 'No',
    c.seoTitle,
    c.seoDesc,
    c.notes
  ].map(v => `"${String(v||'').replace(/"/g,'""')}"`));
  const csv = [headers.map(h=>`"${h}"`), ...rows].map(r=>r.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'}));
  const a = document.createElement('a'); a.href=url; a.download='socieva-report.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ========== POSTING ==========
// NOTE: publishing is intentionally queued from the browser only. Platform API
// credentials and actual publish calls must live in Cloud Functions/backend code.
const POSTING_ACCOUNTS = [
  {id:'ig_news',   platform:'instagram', label:'Instagram — News',   handle:'@capitalcomnews'},
  {id:'ig_arabic', platform:'instagram', label:'Instagram — Arabic', handle:'@capitalcomarabia'},
  {id:'youtube',   platform:'youtube',   label:'YouTube',            handle:'Capital.com Arabic'},
  {id:'tiktok',    platform:'tiktok',    label:'TikTok',             handle:'@capital_tiktok'}
];
const POSTING_PLATFORM_DOT_COLOR={instagram:'#e1306c',youtube:'#ff0000',tiktok:'#69c9d0'};
// Hide the "Connect/Manage Instagram account" UI once setup is done — flip to true to bring it back.
// This only saves non-secret account metadata. Tokens belong in backend secrets.
const POSTING_SHOW_CONNECT_UI=true;
let postingReadyCards=[];
let postingQueue=[]; // persisted — {id, card, destinations:[ids], caption, mode:'now'|'schedule', scheduledAt, status, error, publishedAt}
let postingQueueVisible=5; // how many queue items to show before "Show more"
let editingJobId=null;    // id of the queue item currently showing the inline edit form
let postingComposeCard=null;
let postingSelectedDest=new Set();
let postingWhenMode='now';
let postingSocialAccounts={}; // {accountId:{igUserId, connected}} — no platform tokens in the browser
let connectIgAccountId=null;

// A destination is available once an admin has saved its non-secret account metadata.
function postingAccountConnected(a){
  return!!(postingSocialAccounts[a.id]&&postingSocialAccounts[a.id].connected);
}

async function loadPostingSocialAccounts(){
  try{
    initFirebaseBackend();
    const doc=await firebaseDb.collection('board').doc('socialAccounts').get();
    postingSocialAccounts=doc.exists&&doc.data()?doc.data():{};
  }catch(e){
    postingSocialAccounts={};
  }
}

async function loadPostingQueue(){
  try{
    initFirebaseBackend();
    const snap=await firebaseDb.collection('board').doc('postingQueue').collection('items')
      .orderBy('createdAt','desc')
      .limit(100)
      .get();
    postingQueue=snap.docs.map(doc=>({id:doc.id,...doc.data()}));
    if(!postingQueue.length){
      const legacyDoc=await firebaseDb.collection('board').doc('postingQueue').get();
      postingQueue=legacyDoc.exists&&Array.isArray(legacyDoc.data()?.items)?legacyDoc.data().items:[];
    }
  }catch(e){
    postingQueue=[];
    showToast('Could not load posting queue: '+e.message,'error');
  }
}

async function savePostingJob(job){
  initFirebaseBackend();
  await firebaseDb.collection('board').doc('postingQueue').collection('items').doc(job.id).set({
    ...job,
    updatedAt:firebase.firestore.FieldValue.serverTimestamp(),
    createdBy:currentSession?.userId||null
  },{merge:false});
}

function openConnectInstagram(accountId){
  if(!POSTING_SHOW_CONNECT_UI)return;
  if(!canManageSettings()){showToast('Connecting accounts is restricted to admins','error');return;}
  const account=POSTING_ACCOUNTS.find(a=>a.id===accountId);
  if(!account)return;
  connectIgAccountId=accountId;
  const existing=postingSocialAccounts[accountId];
  document.getElementById('connectIgAccountLabel').textContent=`${account.label} (${account.handle})`;
  document.getElementById('connectIgUserId').value=existing?.igUserId||'';
  document.getElementById('connectIgError').textContent='';
  document.getElementById('connectIgBg').classList.add('open');
}
function closeConnectIgModal(){
  document.getElementById('connectIgBg').classList.remove('open');
  connectIgAccountId=null;
}
async function saveInstagramConnection(){
  if(!connectIgAccountId)return;
  const errEl=document.getElementById('connectIgError');
  errEl.textContent='';
  const igUserId=document.getElementById('connectIgUserId').value.trim();
  if(!igUserId){errEl.textContent='Enter the Instagram Business Account ID.';return;}
  const btn=document.getElementById('connectIgSaveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  try{
    initFirebaseBackend();
    await firebaseDb.collection('board').doc('socialAccounts').set({
      [connectIgAccountId]:{igUserId,connected:true,connectedAt:Date.now()}
    },{merge:true});
    postingSocialAccounts[connectIgAccountId]={igUserId,connected:true,connectedAt:Date.now()};
    renderPostingAccountsBar();
    if(document.getElementById('postingComposeBg').classList.contains('open'))renderPostingDestGroup();
    showToast('Instagram account metadata saved','success');
    closeConnectIgModal();
  }catch(e){
    errEl.textContent='Could not save: '+e.message;
  }finally{
    btn.disabled=false;btn.textContent='Save connection';
  }
}

function postingThumbSrc(c){
  return safeUrl(c.thumbDisplayUrl)||safeUrl(c.thumbUrl)||safeUrl((Array.isArray(c.images)&&c.images[0])?(c.images[0].downloadUrl||c.images[0].shareUrl):'');
}
function postingVideoSrc(c){
  return c._kind==='video'?(safeUrl(c.vidDisplayUrl)||safeUrl(c.vidUrl)):'';
}

async function loadPostingReadyCards(){
  try{
    initFirebaseBackend();
    const [vidSnap,carSnap,vidDoc,carDoc]=await Promise.all([
      firebaseCardsRef('videos').get(),
      firebaseCardsRef('carousels').get(),
      firebaseBoardRef('videos').get(),
      firebaseBoardRef('carousels').get()
    ]);
    const vidLegacy=vidDoc.exists&&Array.isArray(vidDoc.data()?.cards)?vidDoc.data().cards:[];
    const carLegacy=carDoc.exists&&Array.isArray(carDoc.data()?.cards)?carDoc.data().cards:[];
    const vidCards=vidSnap.empty?vidLegacy:cardsFromSnapshot(vidSnap);
    const carCards=carSnap.empty?carLegacy:cardsFromSnapshot(carSnap);
    const vidReadyIdx=STAGES.indexOf('Ready to post');
    const carReadyIdx=CAROUSEL_STAGES.indexOf('Ready to post');
    postingReadyCards=[
      ...vidCards.filter(c=>c.stage===vidReadyIdx).map(c=>({...c,_kind:'video'})),
      ...carCards.filter(c=>c.stage===carReadyIdx).map(c=>({...c,_kind:'carousel'}))
    ];
  }catch(e){
    postingReadyCards=[];
    showToast('Could not load ready-to-post content: '+e.message,'error');
  }
}

function renderPostingAccountsBar(){
  document.getElementById('postingAccountsBar').innerHTML=POSTING_ACCOUNTS.map(a=>{
    const connected=postingAccountConnected(a);
    const manageable=POSTING_SHOW_CONNECT_UI&&a.platform==='instagram'&&canManageSettings();
    return`<span class="posting-account-chip ${connected?'connected':'disconnected'}" title="${escHtml(a.handle)}${connected?'':' — not connected'}">
      <span class="dot"></span>${escHtml(a.label)}
      ${manageable?`<button type="button" class="posting-account-manage" data-id="${escHtml(a.id)}">${connected?'Manage':'Connect'}</button>`:''}
    </span>`;
  }).join('');
  document.querySelectorAll('#postingAccountsBar .posting-account-manage').forEach(btn=>{
    btn.addEventListener('click',e=>{e.stopPropagation();openConnectInstagram(btn.dataset.id);});
  });
}

function renderPostingReadyGrid(){
  const grid=document.getElementById('postingReadyGrid');
  document.getElementById('postingReadyEmpty')?.remove();
  if(!postingReadyCards.length){
    grid.innerHTML='';
    grid.style.display='none';
    grid.insertAdjacentHTML('afterend','<div class="posting-empty" id="postingReadyEmpty">Nothing is marked "Ready to post" yet.</div>');
    return;
  }
  grid.style.display='';
  grid.innerHTML=postingReadyCards.map((c,i)=>{
    const thumb=postingThumbSrc(c);
    const vidSrc=postingVideoSrc(c);
    const videoPoster=thumb?` poster="${escHtml(thumb)}"`:'';
    let media;
    if(vidSrc){
      media=`<video class="card-video-preview" src="${escHtml(vidSrc)}"${videoPoster} preload="metadata" muted playsinline onloadedmetadata="try{if(this.currentTime===0)this.currentTime=0.1}catch(e){}"></video><div class="card-media-play">▶</div><span class="card-media-caption">Video — click to preview</span>`;
    }else if(thumb){
      media=`<img src="${escHtml(thumb)}" alt="">`;
    }else{
      media=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14l4-4 3 3 4-5 4 6"/></svg>`;
    }
    return`<div class="posting-card" data-idx="${i}">
      <div class="posting-card-thumb${vidSrc?' has-video':''}" ${vidSrc?`data-vid="${escHtml(vidSrc)}" data-name="${escHtml(c.name||'')}"`:''}>
        <span class="posting-card-type">${c._kind}</span>
        ${media}
      </div>
      <div class="posting-card-name">${escHtml(c.name||'Untitled')}</div>
      <div class="posting-card-meta">${escHtml(c.category||'—')} · ${escHtml(c.format||'')}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.posting-card-thumb.has-video').forEach(el=>{
    el.addEventListener('click',e=>{
      e.stopPropagation();
      openLightbox('vid',el.dataset.vid,el.dataset.name);
    });
  });
  grid.querySelectorAll('.posting-card').forEach(el=>{
    el.addEventListener('click',()=>openPostingCompose(postingReadyCards[parseInt(el.dataset.idx)]));
  });
}

function postingStatusLabel(item){
  if(item.status==='published')return'Published';
  if(item.status==='partial')return'Partially published';
  if(item.status==='failed')return'Failed';
  if(item.status==='publishing')return'Publishing…';
  if(item.status==='queued')return'Queued';
  return item.mode==='schedule'?'Scheduled':'Pending';
}

function renderPostingQueue(){
  const list=document.getElementById('postingQueueList');
  if(!postingQueue.length){
    list.innerHTML='<div class="posting-empty">No posts scheduled or published yet. Pick something from "Ready to post" above to get started.</div>';
    return;
  }
  const sorted=[...postingQueue].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const visible=sorted.slice(0,postingQueueVisible);
  const remaining=sorted.length-postingQueueVisible;
  const canEdit=s=>s==='scheduled'||s==='queued';
  list.innerHTML=visible.map(item=>{
    const c=item.card;
    const thumb=postingThumbSrc(c);
    const media=thumb?`<img src="${escHtml(thumb)}" alt="">`:'';
    const destLabels=item.destinations.map(id=>POSTING_ACCOUNTS.find(a=>a.id===id)?.label||id).join(', ');
    const when=item.mode==='schedule'&&item.scheduledAt
      ?('Scheduled for '+new Date(item.scheduledAt).toLocaleString())
      :(item.publishedAt?('Published '+new Date(item.publishedAt).toLocaleString()):'Publish now');
    const statusCls=item.status==='published'?'published':item.status==='partial'?'partial':item.status==='failed'?'failed':item.status==='publishing'?'publishing':'scheduled';
    const ytLine=item.youtube&&item.destinations.includes('youtube')
      ?`<div class="posting-queue-sub" style="margin-top:2px"><span style="color:var(--text3)">YouTube:</span> <span>${escHtml(item.youtube.title||'Untitled')}</span>${item.youtube.tags&&item.youtube.tags.length?`<span style="color:var(--text3)"> · tags: ${escHtml(item.youtube.tags.join(', '))}</span>`:''}</div>`
      :'';

    // Inline edit form — shown when user clicks Edit on a scheduled item
    if(editingJobId===item.id&&item.status==='scheduled'){
      const dt=new Date(item.scheduledAt||Date.now());
      const dateVal=dt.toLocaleDateString('en-CA'); // YYYY-MM-DD
      const timeVal=dt.toTimeString().slice(0,5);   // HH:MM
      return`<div class="posting-queue-item posting-queue-item--editing">
        <div class="posting-queue-thumb">${media}</div>
        <div class="posting-queue-main">
          <div class="posting-queue-title">${escHtml(c.name||'Untitled')}</div>
          <div class="posting-edit-form">
            <input type="date" class="posting-edit-input" id="editJobDate_${item.id}" value="${dateVal}">
            <input type="time" class="posting-edit-input" id="editJobTime_${item.id}" value="${timeVal}">
            <div class="posting-edit-actions">
              <button class="posting-edit-save-btn" data-job-id="${item.id}">Save</button>
              <button class="posting-edit-discard-btn" data-job-id="${item.id}">Cancel</button>
            </div>
          </div>
        </div>
      </div>`;
    }

    const actionBtns=canEdit(item.status)
      ?`<div class="posting-queue-actions">
          ${item.status==='scheduled'?`<button class="posting-edit-btn" data-job-id="${item.id}">Edit</button>`:''}
          <button class="posting-cancel-btn" data-job-id="${item.id}">Cancel</button>
        </div>`
      :'';
    return`<div class="posting-queue-item">
      <div class="posting-queue-thumb">${media}</div>
      <div class="posting-queue-main">
        <div class="posting-queue-title">${escHtml(c.name||'Untitled')}</div>
        <div class="posting-queue-sub">
          <span class="posting-status ${statusCls}">${postingStatusLabel(item)}</span>
          <span>${escHtml(destLabels)}</span>
          <span>· ${escHtml(when)}</span>
          ${item.status==='failed'&&item.error?`<span style="color:#f87171">— ${escHtml(item.error)}</span>`:''}
        </div>
        ${ytLine}
      </div>
      ${actionBtns}
    </div>`;
  }).join('')+(remaining>0
    ?`<button class="posting-show-more-btn" id="postingShowMoreBtn">Show ${Math.min(remaining,5)} more <span style="color:var(--text3)">(${remaining} remaining)</span></button>`
    :'');

  // Wire up all queue actions via event delegation on the list
  list.querySelectorAll('.posting-edit-btn').forEach(btn=>btn.addEventListener('click',()=>{
    editingJobId=btn.dataset.jobId; renderPostingQueue();
  }));
  list.querySelectorAll('.posting-cancel-btn').forEach(btn=>btn.addEventListener('click',()=>cancelPostingJob(btn.dataset.jobId)));
  list.querySelectorAll('.posting-edit-save-btn').forEach(btn=>btn.addEventListener('click',()=>saveEditJob(btn.dataset.jobId)));
  list.querySelectorAll('.posting-edit-discard-btn').forEach(btn=>btn.addEventListener('click',()=>{
    editingJobId=null; renderPostingQueue();
  }));
  if(remaining>0){
    document.getElementById('postingShowMoreBtn').addEventListener('click',()=>{
      postingQueueVisible+=5; renderPostingQueue();
    });
  }
}

async function cancelPostingJob(id){
  if(!confirm('Cancel this post?'))return;
  try{
    initFirebaseBackend();
    await firebaseDb.collection('board').doc('postingQueue').collection('items').doc(id).delete();
    postingQueue=postingQueue.filter(item=>item.id!==id);
    if(editingJobId===id)editingJobId=null;
    renderPostingQueue();
    showToast('Post cancelled','success');
  }catch(e){
    showToast('Could not cancel: '+e.message,'error');
  }
}

async function saveEditJob(id){
  const dateEl=document.getElementById('editJobDate_'+id);
  const timeEl=document.getElementById('editJobTime_'+id);
  if(!dateEl||!timeEl)return;
  const scheduledAt=new Date(dateEl.value+'T'+timeEl.value).getTime();
  if(!scheduledAt||isNaN(scheduledAt)||scheduledAt<=Date.now()){
    showToast('Pick a time in the future','error');return;
  }
  try{
    initFirebaseBackend();
    await firebaseDb.collection('board').doc('postingQueue').collection('items').doc(id).update({
      scheduledAt,
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    });
    const idx=postingQueue.findIndex(item=>item.id===id);
    if(idx!==-1)postingQueue[idx]={...postingQueue[idx],scheduledAt};
    editingJobId=null;
    renderPostingQueue();
    showToast('Schedule updated','success');
  }catch(e){
    showToast('Could not update: '+e.message,'error');
  }
}

function postingDefaultCaption(c){
  const title=(c.seoTitle||'').trim();
  const desc=(c.seoDesc||'').trim();
  if(title&&desc)return title+'\n\n'+desc;
  return title||desc||'';
}

function openPostingCompose(c){
  postingComposeCard=c;
  postingSelectedDest=new Set();
  postingWhenMode='now';
  const thumb=postingThumbSrc(c);
  const vidSrc=postingVideoSrc(c);
  const previewMedia=vidSrc
    ?`<div class="posting-queue-thumb has-video" data-vid="${escHtml(vidSrc)}" data-name="${escHtml(c.name||'')}" title="Click to preview the video">${thumb?`<img src="${escHtml(thumb)}" alt="">`:''}<div class="card-media-play" style="font-size:14px">▶</div></div>`
    :`<div class="posting-queue-thumb">${thumb?`<img src="${escHtml(thumb)}" alt="">`:''}</div>`;
  document.getElementById('postingComposePreview').innerHTML=`
    ${previewMedia}
    <div class="posting-queue-main">
      <div class="posting-queue-title">${escHtml(c.name||'Untitled')}</div>
      <div class="posting-queue-sub"><span class="tag" style="background:rgba(244,235,232,0.08);color:var(--text3)">${escHtml(c._kind)}</span><span>${escHtml(c.category||'—')}</span>${vidSrc?'<span style="color:var(--text3)">· <a href="javascript:void(0)" id="postingPreviewVideoLink">preview video</a></span>':''}</div>
    </div>`;
  if(vidSrc){
    const openVidPreview=()=>openLightbox('vid',vidSrc,c.name||'');
    document.getElementById('postingComposePreview').querySelector('.posting-queue-thumb.has-video')?.addEventListener('click',openVidPreview);
    document.getElementById('postingPreviewVideoLink')?.addEventListener('click',openVidPreview);
  }
  const caption=postingDefaultCaption(c);
  const captionEl=document.getElementById('postingCaption');
  captionEl.value=caption;
  updatePostingCaptionCount();
  const help=document.getElementById('postingCaptionHelp');
  if(!caption){
    help.innerHTML='<span style="color:#e8a83b">This ticket has no SEO title/description yet — please write a caption before publishing.</span>';
  }else{
    help.textContent="Pulled automatically from the ticket's SEO title & description. Edit as needed — the same text is sent to every selected destination.";
  }
  document.getElementById('postingYtTitle').value=(c.seoTitle||c.name||'').trim();
  document.getElementById('postingYtDescription').value=(c.seoDesc||'').trim();
  document.getElementById('postingYtTags').value='';
  document.getElementById('postingYtError').textContent='';
  updatePostingYoutubeFieldsVisibility();
  document.querySelectorAll('#postingWhenGroup .fp-pill').forEach(p=>p.classList.toggle('active',p.dataset.val==='now'));
  document.getElementById('postingScheduleInputs').style.display='none';
  document.getElementById('postingScheduleDate').value='';
  document.getElementById('postingScheduleTime').value='';
  document.getElementById('postingComposeError').textContent='';
  document.getElementById('postingComposeNote').textContent=POSTING_ACCOUNTS.some(a=>postingAccountConnected(a)&&a.platform==='instagram')
    ?'This creates a backend-ready publishing job. Actual platform publishing runs from Cloud Functions, not the browser.'
    :'Connect account metadata first. Platform tokens must be configured in backend secrets.';
  renderPostingDestGroup();
  document.getElementById('postingComposeBg').classList.add('open');
}

function closePostingCompose(){
  document.getElementById('postingComposeBg').classList.remove('open');
  postingComposeCard=null;
}

function updatePostingCaptionCount(){
  const v=document.getElementById('postingCaption').value;
  document.getElementById('postingCaptionCount').textContent=v.length+' characters';
}

function renderPostingDestGroup(){
  document.getElementById('postingDestGroup').innerHTML=POSTING_ACCOUNTS.map(a=>{
    const connected=postingAccountConnected(a);
    return`<button type="button" class="posting-dest-chip ${postingSelectedDest.has(a.id)?'active':''} ${connected?'':'is-disabled'}" data-id="${escHtml(a.id)}" ${connected?'':'disabled'} title="${connected?escHtml(a.handle):'Not connected yet'}">
      <span class="dot" style="background:${POSTING_PLATFORM_DOT_COLOR[a.platform]||'currentColor'}"></span>${escHtml(a.label)}
    </button>`;
  }).join('');
  document.querySelectorAll('#postingDestGroup .posting-dest-chip').forEach(btn=>{
    if(btn.disabled)return;
    btn.addEventListener('click',()=>{
      const id=btn.dataset.id;
      if(postingSelectedDest.has(id))postingSelectedDest.delete(id);
      else postingSelectedDest.add(id);
      btn.classList.toggle('active',postingSelectedDest.has(id));
      updatePostingYoutubeFieldsVisibility();
    });
  });
  updatePostingYoutubeFieldsVisibility();
}

function postingDestPlatforms(){
  return new Set([...postingSelectedDest].map(id=>POSTING_ACCOUNTS.find(a=>a.id===id)?.platform).filter(Boolean));
}

// YouTube publishes with its own title/description/tags rather than the shared caption
// (Instagram and TikTok only take a caption), so its fields only show up when a YouTube
// destination is selected.
function updatePostingYoutubeFieldsVisibility(){
  const wrap=document.getElementById('postingYoutubeFields');
  const showYoutube=postingDestPlatforms().has('youtube');
  wrap.style.display=showYoutube?'':'none';
  if(showYoutube)document.getElementById('postingYtError').textContent='';
}

async function confirmPostingCompose(){
  const errEl=document.getElementById('postingComposeError');
  errEl.textContent='';
  const caption=document.getElementById('postingCaption').value.trim();
  if(!caption){errEl.textContent='Please write a caption before publishing.';return;}
  if(!postingSelectedDest.size){errEl.textContent='Select at least one destination.';return;}
  let youtube=null;
  if(postingDestPlatforms().has('youtube')){
    const ytErrEl=document.getElementById('postingYtError');
    ytErrEl.textContent='';
    const title=document.getElementById('postingYtTitle').value.trim();
    const description=document.getElementById('postingYtDescription').value.trim();
    const tags=document.getElementById('postingYtTags').value.split(',').map(t=>t.trim()).filter(Boolean);
    if(!title){ytErrEl.textContent='Please add a title for YouTube.';return;}
    if(!description){ytErrEl.textContent='Please add a description for YouTube.';return;}
    youtube={title,description,tags};
  }
  let scheduledAt=null;
  if(postingWhenMode==='schedule'){
    const d=document.getElementById('postingScheduleDate').value;
    const t=document.getElementById('postingScheduleTime').value;
    if(!d||!t){errEl.textContent='Pick a date and time for the scheduled post.';return;}
    scheduledAt=new Date(d+'T'+t).getTime();
    if(!scheduledAt||isNaN(scheduledAt)||scheduledAt<=Date.now()){errEl.textContent='Pick a time in the future.';return;}
  }
  const card=postingComposeCard;
  const destIds=[...postingSelectedDest];
  let status=postingWhenMode==='schedule'?'scheduled':'queued',publishError=null,publishedAt=null;
  const btn=document.getElementById('postingConfirmBtn');
  const originalLabel=btn.textContent;

  const postingJob={
    id:uid(),
    card,
    destinations:destIds,
    caption,
    youtube,
    mode:postingWhenMode,
    scheduledAt,
    status,
    publishedAt,
    error:publishError,
    createdAt:Date.now()
  };
  postingQueue.push(postingJob);
  btn.disabled=true;btn.textContent='Saving job...';
  try{
    await savePostingJob(postingJob);
  }catch(e){
    postingQueue=postingQueue.filter(item=>item.id!==postingJob.id);
    errEl.textContent=/already been terminated/i.test(e.message||'')
      ?'Connection went stale (common after a phone/laptop sleeps for a while). Reload the page and try again.'
      :'Could not save posting job: '+e.message;
    btn.disabled=false;btn.textContent=originalLabel;
    return;
  }
  btn.disabled=false;btn.textContent=originalLabel;
  renderPostingQueue();
  showToast(postingWhenMode==='schedule'?'Post scheduled':'Post queued for backend publishing','success');
  closePostingCompose();
  if(status==='queued'){
    // "Publish now" shouldn't have to wait for the next backend sweep
    // (every few minutes) — kick the worker immediately. Fire-and-forget:
    // if this call fails for any reason the scheduled sweep will still
    // pick the job up shortly after, so we don't surface errors here.
    try{
      firebaseFunctions.httpsCallable('processPostingQueueNow')().catch(()=>{});
    }catch(e){}
  }
}

async function openPosting(){
  if(!canManageSettings()){showToast('Posting is restricted to admins','error');return;}
  postingQueueVisible=5; editingJobId=null; // reset pagination + edit state each time
  document.getElementById('postingOverlay').classList.add('open');
  await loadPostingSocialAccounts();
  await loadPostingQueue();
  renderPostingAccountsBar();
  document.getElementById('postingQueueNote').textContent=POSTING_ACCOUNTS.some(a=>postingAccountConnected(a)&&a.platform==='instagram')
    ?'Scheduled, queued, published, and failed posts. Browser only queues jobs; backend functions publish them.'
    :'Scheduled and queued posts. Connect account metadata, then configure backend publishing secrets.';
  document.getElementById('postingReadyGrid').innerHTML='<div class="posting-empty">Loading…</div>';
  document.getElementById('postingReadyGrid').style.display='';
  await loadPostingReadyCards();
  renderPostingReadyGrid();
  renderPostingQueue();
}
function closePosting(){ document.getElementById('postingOverlay').classList.remove('open'); }

document.getElementById('postingWhenGroup').addEventListener('click',e=>{
  const btn=e.target.closest('.fp-pill');
  if(!btn)return;
  postingWhenMode=btn.dataset.val;
  document.querySelectorAll('#postingWhenGroup .fp-pill').forEach(p=>p.classList.toggle('active',p===btn));
  document.getElementById('postingScheduleInputs').style.display=postingWhenMode==='schedule'?'flex':'none';
});
document.getElementById('postingCaption').addEventListener('input',updatePostingCaptionCount);
document.getElementById('postingConfirmBtn').addEventListener('click',confirmPostingCompose);
document.getElementById('closePostingComposeBtn').addEventListener('click',closePostingCompose);
document.getElementById('postingComposeBg').addEventListener('click',e=>{ if(e.target.id==='postingComposeBg')closePostingCompose(); });
document.getElementById('closeConnectIgBtn').addEventListener('click',closeConnectIgModal);
document.getElementById('connectIgBg').addEventListener('click',e=>{ if(e.target.id==='connectIgBg')closeConnectIgModal(); });
document.getElementById('connectIgSaveBtn').addEventListener('click',saveInstagramConnection);

// ========== EVENT LISTENERS ==========
document.getElementById('loginSubmitBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('loginUsername').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('loginPassword').focus(); });
document.getElementById('changePwSubmitBtn').addEventListener('click', doChangePassword);
document.getElementById('changePwConfirm').addEventListener('keydown', e=>{ if(e.key==='Enter') doChangePassword(); });
document.getElementById('changePwNew').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('changePwConfirm').focus(); });


document.getElementById('userAvatar').addEventListener('click', e=>{
  e.stopPropagation();
  toggleAccountMenu();
});
document.getElementById('accountLogoutBtn').addEventListener('click', doLogout);
document.addEventListener('click', e=>{
  if(!document.getElementById('accountMenuWrap').contains(e.target))closeAccountMenu();
});
document.addEventListener('keydown', e=>{
  if(e.key==='Escape')closeAccountMenu();
});

document.getElementById('thumbFile').addEventListener('change',function(){if(this.files[0])handleUpload(this.files[0],'thumb');});
document.getElementById('vidFile').addEventListener('change',function(){if(this.files[0])handleUpload(this.files[0],'vid');});
document.getElementById('carouselImagesFile').addEventListener('change',function(){if(this.files.length)handleCarouselImagesUpload(Array.from(this.files));this.value='';});

function assignFileState(card){
  const isC=boardMode==='carousels';
  card.thumbUrl=isC?(carouselImages[0]?.shareUrl||null):thumbFileUrl;
  card.thumbItemId=isC?(carouselImages[0]?.itemId||null):thumbItemId;
  card.thumbDisplayUrl=isC?(carouselImages[0]?.downloadUrl||null):thumbDisplayUrl;
  card.vidUrl=isC?null:vidFileUrl;
  card.vidItemId=isC?null:vidItemId;
  card.vidDisplayUrl=isC?null:vidDisplayUrl;
  card.images=isC?carouselImages.map(img=>({shareUrl:img.shareUrl,itemId:img.itemId||null,downloadUrl:img.downloadUrl||null})):null;
}

document.getElementById('saveBtn').addEventListener('click',async()=>{
  const name=document.getElementById('fName').value.trim();
  if(!name){document.getElementById('fName').focus();document.getElementById('fNameError').textContent='Required';return;}
  const existingCard=editId?cards.find(c=>c.id===editId):null;
  const card={
    id:editId||uid(),name,
    createdAt:existingCard?.createdAt||new Date().toISOString(),
    format:document.getElementById('fFormat').value,
    category:document.getElementById('fCategory').value,
    presenter:document.getElementById('fPresenter').value,
    assign:document.getElementById('fAssign').value,
    editor:document.getElementById('fEditor').value,
    priority:document.getElementById('fPriority').value,
    postDate:document.getElementById('fPostDate').value,
    dueDate:document.getElementById('fDueDate').value,
    channel:document.getElementById('fChannel').value,
    segment:document.getElementById('fSegment').value,
    script:document.getElementById('fScript').value,
    seoTitle:document.getElementById('fSeoTitle').value,
    seoDesc:document.getElementById('fSeoDesc').value,
    notes:document.getElementById('fNotes').value,
    compliance:document.getElementById('fCompliance').value,
    approve:document.getElementById('fApprove').value,
    stage:parseInt(document.getElementById('fStage').value),
    slidesCount:boardMode==='carousels'?(parseInt(document.getElementById('fSlidesCount').value)||null):null
  };
  assignFileState(card);
  applyStageAudit(card,existingCard);
  const btn=document.getElementById('saveBtn');
  // If an upload is still in-flight, wait for it to finish first
  if(activeUploadPromises.size){
    btn.textContent='Waiting for upload...';btn.disabled=true;
    await waitForActiveUploads();
    // Modal may have been closed or switched while we waited
    if(!document.getElementById('modalBg').classList.contains('open'))return;
    btn.textContent='Save';btn.disabled=false;
    assignFileState(card); // re-read file state now that upload is done
  }
  btn.textContent='Saving...';btn.disabled=true;
  const previousCards=JSON.parse(JSON.stringify(cards));
  try{
    if(editId){
      const idx=cards.findIndex(c=>c.id===editId);
      if(idx<0)throw new Error('This card no longer exists. Refresh the board and retry.');
      cards[idx]=card;
    }else{cards.push(card);}
    await saveData();
    await finalizeSavedModalFiles().catch(()=>{});
    closeModal({saved:true});renderAll();showToast(boardMode==='carousels'?'Carousel saved':'Video saved','success');
  }catch(e){
    cards=previousCards;
    renderAll();
    document.getElementById('fNameError').textContent='Save failed: '+e.message;
    showToast('Save failed: '+e.message,'error');
  }
  btn.textContent='Save';btn.disabled=false;
});

document.getElementById('deleteBtn').addEventListener('click',async()=>{
  if(!editId)return;
  const cardToDelete=cards.find(c=>c.id===editId);if(!cardToDelete)return;
  const originalIndex=cards.indexOf(cardToDelete);

  // Remove the card locally and commit the delete to Firestore immediately.
  // The old approach (5-second delayed save) caused a race: any Firestore
  // snapshot that arrived during the wait window still contained the deleted
  // card, and flushing it after the timer cleared pendingDelete brought the
  // card back. Saving immediately eliminates that window entirely.
  cards=cards.filter(c=>c.id!==editId);
  closeModal();
  renderAll();

  try{
    await saveData();
  }catch(e){
    // Rollback the local removal if the write failed.
    cards.splice(Math.min(originalIndex,cards.length),0,cardToDelete);
    renderAll();
    showToast('Delete failed: '+e.message,'error');
    return;
  }

  // Delete committed. Fire-and-forget the storage cleanup.
  deleteStorageItems(cardFileItemIds(cardToDelete)).catch(()=>{});

  // Offer Undo for 5 seconds. Undo re-creates the card in Firestore (the
  // card's id is no longer in cardBaselineData after the delete, so saveData
  // treats it as a new card and writes it back with tx.set).
  // Guard against board-mode switch during the undo window: if the user
  // flipped to the other board (videos ↔ carousels) before clicking Undo,
  // the card belongs to a different collection and we must not splice it
  // into the wrong cards array.
  const modeAtDelete=boardMode;
  showToastUndo('"'+cardToDelete.name+'" deleted',async()=>{
    if(boardMode!==modeAtDelete){showToast('Cannot undo — board mode changed','error');return;}
    cards.splice(Math.min(originalIndex,cards.length),0,cardToDelete);
    renderAll();
    try{await saveData();}catch(e){showToast('Undo failed: '+e.message,'error');}
  });
});

document.getElementById('closeModalBtn').addEventListener('click',closeModal);
document.getElementById('cancelBtn').addEventListener('click',closeModal);
document.getElementById('openAddBtn').addEventListener('click',()=>openAdd(0));
document.getElementById('openSettingsBtn').addEventListener('click',openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click',closeSettings);
document.getElementById('cancelSettingsBtn').addEventListener('click',closeSettings);
document.getElementById('addPersonBtn').addEventListener('click',addSettingsPerson);
document.getElementById('addCategoryBtn').addEventListener('click',addSettingsCategory);
document.getElementById('saveSettingsBtn').addEventListener('click',saveSettings);
document.getElementById('newPersonName').addEventListener('keydown',e=>{if(e.key==='Enter')addSettingsPerson();});
document.getElementById('newCategoryName').addEventListener('keydown',e=>{if(e.key==='Enter')addSettingsCategory();});
document.getElementById('settingsBg').addEventListener('click',function(e){if(e.target===this)closeSettings();});
document.getElementById('searchInput').addEventListener('input',debounce(e=>{activeFilters.q=e.target.value.toLowerCase();updateFilterBadge();renderAll();}));
document.getElementById('filterToggleBtn').addEventListener('click',toggleFilterPanel);
document.getElementById('sortDirBtn').addEventListener('click',()=>{
  sortDir=sortDir==='asc'?'desc':'asc';
  document.getElementById('sortDirBtn').textContent=sortDir==='asc'?'↑':'↓';
  renderAll();
});
document.getElementById('sortBySelect').addEventListener('change',e=>{sortBy=e.target.value;renderAll();});

// Stage pills built dynamically — see renderStagePills()
// Format pills
document.querySelectorAll('#fpFormatGroup .fp-pill').forEach(p=>{
  p.addEventListener('click',()=>{
    activeFilters.format=p.dataset.val;
    document.querySelectorAll('#fpFormatGroup .fp-pill').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    updateFilterBadge();renderAll();
  });
});
// Panel selects
[['fpCategory','category'],['fpPriority','priority'],['fpCompliance','compliance'],
 ['fpPresenter','presenter'],['fpAssign','assign'],['fpEditor','editor']].forEach(([id,key])=>{
  document.getElementById(id).addEventListener('change',e=>{
    activeFilters[key]=e.target.value;
    e.target.classList.toggle('active',!!e.target.value);
    updateFilterBadge();renderAll();
  });
});
// Date inputs
[['fpPostFrom','postDateFrom'],['fpPostTo','postDateTo'],
 ['fpDueFrom','dueDateFrom'],['fpDueTo','dueDateTo']].forEach(([id,key])=>{
  document.getElementById(id).addEventListener('change',e=>{
    activeFilters[key]=e.target.value;
    e.target.classList.toggle('active',!!e.target.value);
    updateFilterBadge();renderAll();
  });
});
// Text inputs
document.getElementById('fpChannel').addEventListener('input',debounce(e=>{activeFilters.channel=e.target.value;e.target.classList.toggle('active',!!e.target.value);updateFilterBadge();renderAll();}));
document.getElementById('fpSegment').addEventListener('input',debounce(e=>{activeFilters.segment=e.target.value;e.target.classList.toggle('active',!!e.target.value);updateFilterBadge();renderAll();}));
// Checkboxes
[['fpHasThumb','hasThumb','fpHasThumbLabel'],['fpHasVid','hasVid','fpHasVidLabel'],
 ['fpOverdue','overdue','fpOverdueLabel'],['fpDueSoon','dueSoon','fpDueSoonLabel']].forEach(([cbId,key,lblId])=>{
  document.getElementById(cbId).addEventListener('change',e=>{
    activeFilters[key]=e.target.checked;
    document.getElementById(lblId).classList.toggle('active',e.target.checked);
    updateFilterBadge();renderAll();
  });
});
document.getElementById('fpClearBtn').addEventListener('click',clearAllFilters);
document.getElementById('modalBg').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')document.getElementById('saveBtn').click();});
// Reports
// Board tabs
document.querySelectorAll('.board-tab').forEach(btn=>{
  btn.addEventListener('click',()=>switchBoardMode(btn.dataset.mode));
});

document.getElementById('openReportsBtn').addEventListener('click', openReports);
document.getElementById('closeReportsBtn').addEventListener('click', closeReports);
document.getElementById('syncDot').addEventListener('click', forceRefreshBoard);
document.getElementById('openPostingBtn').addEventListener('click', openPosting);
document.getElementById('closePostingBtn').addEventListener('click', closePosting);
document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
document.getElementById('printReportBtn').addEventListener('click', () => window.print());
document.querySelectorAll('.report-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    reportTab=btn.dataset.reportTab;
    if(reportTab==='platforms'){platformReportData=null;platformTopContentMode=null;}
    renderReport();
  });
});
document.getElementById('platformReportAccount').addEventListener('change',e=>{
  platformReportAccountId=e.target.value;
  platformReportData=null;
  platformTopContentMode=null;
  renderReport();
});
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reportPeriod = btn.dataset.period;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('reportCustomDates').style.display = reportPeriod === 'custom' ? 'flex' : 'none';
    if(reportTab==='platforms'){platformReportData=null;platformTopContentMode=null;}
    renderReport();
  });
});
document.getElementById('reportFromDate').addEventListener('change',()=>{if(reportTab==='platforms'){platformReportData=null;platformTopContentMode=null;}renderReport();});
document.getElementById('reportToDate').addEventListener('change',()=>{if(reportTab==='platforms'){platformReportData=null;platformTopContentMode=null;}renderReport();});

document.getElementById('lightboxClose').addEventListener('click',closeLightbox);
document.getElementById('lightbox').addEventListener('click',function(e){if(e.target===this)closeLightbox();});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeLightbox();if(document.getElementById('settingsBg').classList.contains('open'))closeSettings();}
});

window.addEventListener('beforeunload',e=>{
  if(activeUploadPromises.size){e.preventDefault();e.returnValue='';}
});

init().catch(e=>console.error(e));
