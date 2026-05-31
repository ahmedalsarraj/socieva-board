// ========== CONFIG ==========
const CLIENT_ID = 'd16994f5-e9f0-49d6-8ee6-3e1c3ad57bf0';
const TENANT_ID = '4cd6b3cc-09bd-467e-a6ee-78d2c7926a5d';
const SCOPES = ['Files.ReadWrite.All','User.Read','offline_access'];
const FOLDER_NAME = 'Socieva-Board';
const DATA_FILE = 'board-data.json';
const USERS_FILE = 'users.json';
const CAROUSELS_FILE = 'carousels-data.json';
const SHARED_BOARD_FOLDER_URL = 'https://socievastudio-my.sharepoint.com/:f:/g/personal/itadmin_socievastudio_onmicrosoft_com/IgDUrDgaFrsPSbiRtH0EMGuhAXiI5eYbLKQLvnZhgUuFPlg?e=W3B70k';

const LOCAL_MODE_KEY = 'sb_local_mode';
const LOCAL_MODE = localStorage.getItem(LOCAL_MODE_KEY) === '1';

const SEED_USERNAMES = ['majd','jamal','shamma','osaid','ahmed','aya','nawal','sara','mustafa'];
const ADMIN_USERNAMES = ['ahmed','sara'];
const DEFAULT_PASSWORD = '12AS223@';
const SESSION_KEY = 'sb_session_v2';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// ========== TOKEN WORKER ==========
const TOKEN_WORKER_URL = 'https://socieva-onedrive-token.ahmedalsarrajm.workers.dev';
let cachedToken = null;
let tokenExpiresAt = 0;

// ========== DEBOUNCE ==========
function debounce(fn,delay=200){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),delay);};}

// ========== DISPLAY URL TTL ==========
const DISPLAY_URL_TTL_MS = 45 * 60 * 1000; // 45 min (Graph download URLs expire in ~60 min)

// Concurrency limiter — max 5 parallel Graph requests
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
let boardUsers = [];
let cards = [];
let editId = null;
let carouselImages = []; // [{shareUrl,itemId,downloadUrl}] for carousel multi-image
let thumbOneDriveUrl = null;
let vidOneDriveUrl = null;
let thumbItemId = null;
let vidItemId = null;
let thumbDisplayUrl = null;
let vidDisplayUrl = null;
let boardSettings = null;
let settingsDraft = null;
let boardDriveId = null;
let boardRootItemId = null;
let dragCardId = null;
let pendingDelete = null;
let expandedStages = new Set();
let activeFilters = {q:'',format:'',stage:'',category:'',priority:'',compliance:'',presenter:'',assign:'',editor:'',postDateFrom:'',postDateTo:'',dueDateFrom:'',dueDateTo:'',channel:'',segment:'',hasThumb:false,hasVid:false,overdue:false,dueSoon:false};
let sortBy = 'priority';
let sortDir = 'asc';
let filterPanelOpen = false;
let boardMode = 'videos'; // 'videos' | 'carousels'
let carouselCards = [];
let carouselLoaded = false;
let lastETag = {videos:'',carousels:''};

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
function fmtDate(d){if(!d)return'';const p=d.split('-');const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return parseInt(p[2])+' '+m[parseInt(p[1])-1]}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function escHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function safeUrl(u){if(!u)return'';const s=String(u).trim();return(s.startsWith('https://')||s.startsWith('http://')||s.startsWith('blob:')||s.startsWith('data:image/')||s.startsWith('data:video/'))?s:''}
function jsArg(s){return escHtml(JSON.stringify(String(s??'')))}
function norm(s){return String(s||'').trim().toLowerCase()}
function pathPart(s){return encodeURIComponent(String(s))}
function drivePath(...parts){return parts.map(pathPart).join('/')}

// ========== LOCAL STORAGE BACKEND ==========
function lsSet(key, data){ localStorage.setItem('sb_data_'+key, JSON.stringify(data)); }
function lsGet(key){
  const raw = localStorage.getItem('sb_data_'+key);
  if(!raw){ const e=new Error('Not found'); e.status=404; throw e; }
  return JSON.parse(raw);
}

// ========== CRYPTO / PASSWORDS ==========
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name:'PBKDF2', salt:enc.encode(salt), iterations:100000, hash:'SHA-256'},
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function generateSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('');
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
  if(LOCAL_MODE){
    try{ const data=lsGet(USERS_FILE); boardUsers=Array.isArray(data.users)?data.users:[]; return true; }
    catch(e){ if(e.status!==404)throw e; return false; }
  }
  try {
    const meta = await apiCall(await boardPath(USERS_FILE));
    const blob = await apiCall(await boardItemContentPath(meta.id), undefined, null, true);
    const data = JSON.parse(await blob.text());
    boardUsers = Array.isArray(data.users) ? data.users : [];
    return true;
  } catch(e) {
    if (e.status !== 404) throw e;
    return false;
  }
}

async function saveUsers() {
  if(LOCAL_MODE){ lsSet(USERS_FILE,{version:1,users:boardUsers}); return; }
  const json = JSON.stringify({version:1, users:boardUsers}, null, 2);
  await apiCall(`${await boardPath(USERS_FILE)}:/content`, 'PUT', new Blob([json],{type:'application/json'}));
}

async function bootstrapUsers() {
  boardUsers = [];
  for (const username of SEED_USERNAMES) {
    const salt = generateSalt();
    const passwordHash = await hashPassword(DEFAULT_PASSWORD, salt);
    boardUsers.push({id:'u_'+uid(), username, passwordHash, salt, mustChangePassword:true,
      role: ADMIN_USERNAMES.includes(username) ? 'admin' : 'user',
      createdAt: new Date().toISOString()
    });
  }
  await saveUsers();
}

async function validateCredentials(username, password) {
  const user = boardUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;
  const hash = await hashPassword(password, user.salt);
  return hash === user.passwordHash ? user : null;
}

// ========== AUTH / SCREENS ==========
function showScreen(id) {
  ['msConnectScreen','loginScreen','changePwScreen'].forEach(s => {
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
    if (user.mustChangePassword) {
      currentSession = {userId:user.id, username:user.username, role:user.role, temp:true};
      document.getElementById('changePwUsername').textContent = user.username;
      document.getElementById('changePwError').textContent = '';
      document.getElementById('changePwNew').value = '';
      document.getElementById('changePwConfirm').value = '';
      showScreen('changePwScreen');
      return;
    }
    const session = {userId:user.id, username:user.username, role:user.role, expiresAt:Date.now()+SESSION_DURATION_MS};
    saveSession(session);
    await startBoardApp(session);
  } catch(e) { errEl.textContent = 'Error: ' + e.message; }
  btn.disabled = false; btn.textContent = 'Sign in';
}

async function doChangePassword() {
  if (!currentSession?.temp) return;
  const newPw = document.getElementById('changePwNew').value;
  const confirmPw = document.getElementById('changePwConfirm').value;
  const errEl = document.getElementById('changePwError');
  errEl.textContent = '';
  if (newPw.length < 8) { errEl.textContent = 'Password must be at least 8 characters'; return; }
  if (newPw === DEFAULT_PASSWORD) { errEl.textContent = 'Cannot use the default password'; return; }
  if (newPw !== confirmPw) { errEl.textContent = 'Passwords do not match'; return; }
  const btn = document.getElementById('changePwSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const idx = boardUsers.findIndex(u => u.id === currentSession.userId);
    if (idx === -1) throw new Error('User not found');
    const newSalt = generateSalt();
    boardUsers[idx].passwordHash = await hashPassword(newPw, newSalt);
    boardUsers[idx].salt = newSalt;
    boardUsers[idx].mustChangePassword = false;
    await saveUsers();
    const session = {userId:currentSession.userId, username:currentSession.username, role:currentSession.role, expiresAt:Date.now()+SESSION_DURATION_MS};
    saveSession(session);
    await startBoardApp(session);
  } catch(e) { errEl.textContent = 'Error: ' + e.message; }
  btn.disabled = false; btn.textContent = 'Set password & continue';
}

function doLogout() {
  clearSession();
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
  showScreen('loginScreen');
}

// ========== MSAL / GRAPH ==========
function sharedBoardFolderUrl(){return String(SHARED_BOARD_FOLDER_URL||'').trim()}
function hasSharedBoardFolder(){return !!safeUrl(sharedBoardFolderUrl())}

async function getBoardRoot(){
  if(!hasSharedBoardFolder())return null;
  if(boardDriveId&&boardRootItemId)return{driveId:boardDriveId,itemId:boardRootItemId};
  const shared=await apiCall(`/shares/${encodeSharingUrl(sharedBoardFolderUrl())}/driveItem`);
  const item=shared.remoteItem||shared;
  const driveId=item.parentReference?.driveId||shared.parentReference?.driveId;
  const itemId=item.id||shared.id;
  if(!driveId||!itemId)throw new Error('Shared board folder link could not be resolved.');
  boardDriveId=driveId; boardRootItemId=itemId;
  return{driveId,itemId};
}
async function boardPath(...parts){
  const root=await getBoardRoot();
  if(root)return`/drives/${root.driveId}/items/${root.itemId}:/${drivePath(...parts)}`;
  return`/me/drive/root:/${drivePath(FOLDER_NAME,...parts)}`;
}
async function boardChildrenPath(){
  const root=await getBoardRoot();
  if(root)return`/drives/${root.driveId}/items/${root.itemId}/children`;
  return`/me/drive/root:/${drivePath(FOLDER_NAME)}:/children`;
}
async function boardItemPath(itemId){
  const root=await getBoardRoot();
  if(root)return`/drives/${root.driveId}/items/${itemId}`;
  return`/me/drive/items/${itemId}`;
}
async function boardItemContentPath(itemId){return`${await boardItemPath(itemId)}/content`}
async function boardCreateLinkPath(itemId){return`${await boardItemPath(itemId)}/createLink`}

function encodeSharingUrl(url){return'u!'+btoa(url).replace(/=/g,'').replace(/\//g,'_').replace(/\+/g,'-')}

async function getToken(){
  const now=Date.now();
  if(cachedToken&&now<tokenExpiresAt-60000)return cachedToken;
  const res=await fetch(TOKEN_WORKER_URL,{method:'POST'});
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.error)throw new Error(data.description||data.error||'Token worker error: '+res.status);
  cachedToken=data.access_token;
  tokenExpiresAt=now+(data.expires_in*1000);
  return cachedToken;
}

async function apiCall(url,method='GET',body=null,isBlob=false,extraHeaders={}){
  const token=await getToken();
  const opts={method,headers:{'Authorization':'Bearer '+token,...extraHeaders}};
  if(body&&!(body instanceof Blob)&&!(body instanceof ArrayBuffer)){
    opts.headers['Content-Type']='application/json';
    opts.body=JSON.stringify(body);
  }else if(body){opts.body=body;}
  const res=await fetch('https://graph.microsoft.com/v1.0'+url,opts);
  if(!res.ok){const err=await res.text();const e=new Error(err||`${res.status} ${res.statusText}`);e.status=res.status;throw e;}
  if(res.status===204)return null;
  if(isBlob)return res.blob();
  return res.json();
}

async function ensureFolder(){
  if(LOCAL_MODE)return;
  if(hasSharedBoardFolder()){await getBoardRoot();return;}
  try{await apiCall(`/me/drive/root:/${drivePath(FOLDER_NAME)}`);}
  catch(e){
    if(e.status!==404)throw e;
    await apiCall('/me/drive/root/children','POST',{name:FOLDER_NAME,folder:{},['@microsoft.graph.conflictBehavior']:'rename'});
  }
}

async function ensureSubfolder(name){
  if(LOCAL_MODE)return;
  await ensureFolder();
  // Skip GET check — 'thumbnails' conflicts with Graph API built-in thumbnail endpoint
  // Just attempt creation; ignore 409 (already exists)
  try{await apiCall(await boardChildrenPath(),'POST',{name,folder:{},['@microsoft.graph.conflictBehavior']:'fail'});}
  catch(e){if(e.status!==409)throw e;}
}

// ========== INIT ==========
async function init(){
  // LOCAL TEST MODE — bypass OneDrive entirely
  if(LOCAL_MODE){
    setLoading(40);
    try{
      const usersExist=await loadUsers();
      if(!usersExist){setLoading(60);await bootstrapUsers();}
    }catch(e){showToast('Local storage error: '+e.message,'error');setLoading(0);return;}
    setLoading(100);setTimeout(()=>setLoading(0),400);
    const session=loadSession();
    if(session){
      const user=boardUsers.find(u=>u.id===session.userId);
      if(user&&!user.mustChangePassword){session.role=user.role;saveSession(session);await startBoardApp(session);return;}
    }
    showScreen('loginScreen');
    return;
  }

  setLoading(20);
  try{await getToken();}
  catch(e){showToast('OneDrive connection failed: '+e.message,'error');showScreen('msConnectScreen');setLoading(0);return;}
  setLoading(40);
  try{
    await ensureFolder();
    const usersExist=await loadUsers();
    if(!usersExist){setLoading(60);await bootstrapUsers();showToast('Board initialized with default users','success');}
  }catch(e){showToast('Storage error: '+e.message,'error');showScreen('msConnectScreen');setLoading(0);return;}
  setLoading(100);setTimeout(()=>setLoading(0),500);
  const session=loadSession();
  if(session){
    const user=boardUsers.find(u=>u.id===session.userId);
    if(user&&!user.mustChangePassword){
      session.role=user.role;
      saveSession(session);
      await startBoardApp(session);
      return;
    }
  }
  showScreen('loginScreen');
}

async function startBoardApp(session){
  currentSession=session;
  showScreen('app');
  document.getElementById('userAvatar').textContent=initials(session.username);
  document.getElementById('userAvatar').title=session.username+(session.role==='admin'?' (admin)':'')+' — click to sign out';
  document.getElementById('openAddBtn').textContent='+ New Video';
  setLoading(30);
  try{
    await ensureFolder();
    await loadData();
    setLoading(80);
  }catch(e){showToast('Board load error: '+e.message,'error');setLoading(0);}
  refreshOptionLists();
  updateSettingsAccess();
  updateFilterBadge();
  renderStagePills();
  renderAll();
  setLoading(100);setTimeout(()=>setLoading(0),400);
  // Refresh display URLs in background — re-render when done
  refreshDisplayUrls().then(()=>renderAll()).catch(()=>{});
  let lastDataSnapshot='';
  setInterval(async()=>{
    if(!currentSession)return;
    if(document.getElementById('modalBg').classList.contains('open'))return;
    if(pendingDelete)return;
    setSyncDot('syncing');
    try{
      await loadData();
      const snapshot=JSON.stringify(cards.map(c=>c.id+c.stage+c.name));
      if(snapshot!==lastDataSnapshot){lastDataSnapshot=snapshot;refreshOptionLists();renderAll();}
      setSyncDot('ok');
    }catch(e){setSyncDot('error');}
  },2*60*1000);
  setInterval(async()=>{
    if(!currentSession)return;
    try{await refreshDisplayUrls();renderAll();}catch(e){}
  },50*60*1000);
}

// ========== BOARD DATA ==========
async function loadLegacyPersonalData(){
  try{
    const meta=await apiCall(`/me/drive/root:/${drivePath(FOLDER_NAME,DATA_FILE)}`);
    const blob=await apiCall(`/me/drive/items/${meta.id}/content`,undefined,null,true);
    parseBoardData(JSON.parse(await blob.text()));
    return true;
  }catch(e){if(e.status!==404)throw e;return false;}
}

function parseBoardData(data){
  if(Array.isArray(data)){cards=data;boardSettings=defaultSettings();return;}
  cards=Array.isArray(data?.cards)?data.cards:[];
  boardSettings=normalizeSettings(data?.settings);
}

function buildBoardPayload(){return{version:2,settings:normalizeSettings(getSettings()),cards};}

async function loadData(){
  if(LOCAL_MODE){
    const file=boardMode==='carousels'?CAROUSELS_FILE:DATA_FILE;
    try{
      const data=lsGet(file);
      if(boardMode==='carousels'){cards=Array.isArray(data.cards)?data.cards:[];}
      else{parseBoardData(data);}
    }catch(e){
      if(e.status!==404)throw e;
      cards=[];
      if(boardMode==='videos')boardSettings=defaultSettings();
    }
    return;
  }
  if(boardMode==='carousels'){
    try{
      const meta=await apiCall(await boardPath(CAROUSELS_FILE));
      lastETag.carousels=meta.eTag||'';
      const blob=await apiCall(await boardItemContentPath(meta.id),undefined,null,true);
      const data=JSON.parse(await blob.text());
      cards=Array.isArray(data.cards)?data.cards:[];
    }catch(e){
      if(e.status!==404)throw e;
      cards=[];
      lastETag.carousels='';
    }
    return;
  }
  try{
    const meta=await apiCall(await boardPath(DATA_FILE));
    lastETag.videos=meta.eTag||'';
    const blob=await apiCall(await boardItemContentPath(meta.id),undefined,null,true);
    parseBoardData(JSON.parse(await blob.text()));
  }catch(e){
    if(e.status!==404)throw e;
    if(hasSharedBoardFolder()&&await loadLegacyPersonalData()){
      await saveData();showToast('Board data moved to shared folder','success');
    }else{cards=[];boardSettings=defaultSettings();}
  }
}

async function saveData(){
  if(LOCAL_MODE){
    const file=boardMode==='carousels'?CAROUSELS_FILE:DATA_FILE;
    const payload=boardMode==='carousels'?{version:1,cards}:buildBoardPayload();
    lsSet(file,payload);
    return;
  }
  if(boardMode==='carousels'){
    const json=JSON.stringify({version:1,cards},null,2);
    const etag=lastETag.carousels;
    const hdrs=etag?{'If-Match':etag}:{};
    let saved;
    try{saved=await apiCall(`${await boardPath(CAROUSELS_FILE)}:/content`,'PUT',new Blob([json],{type:'application/json'}),false,hdrs);}
    catch(e){
      if(e.status===412){const ce=new Error('Data was changed by someone else — reload the page before saving.');ce.status=412;throw ce;}
      throw e;
    }
    if(saved?.eTag)lastETag.carousels=saved.eTag;
    return;
  }
  const json=JSON.stringify(buildBoardPayload(),null,2);
  const etag=lastETag.videos;
  const hdrs=etag?{'If-Match':etag}:{};
  let saved;
  try{saved=await apiCall(`${await boardPath(DATA_FILE)}:/content`,'PUT',new Blob([json],{type:'application/json'}),false,hdrs);}
  catch(e){
    if(e.status===412){const ce=new Error('Data was changed by someone else — reload the page before saving.');ce.status=412;throw ce;}
    throw e;
  }
  if(saved?.eTag)lastETag.videos=saved.eTag;
}

async function switchBoardMode(mode){
  if(boardMode===mode)return;
  // Clear board immediately so old cards don't flash under new mode
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
  try{
    if(mode==='carousels'&&!carouselLoaded){
      await loadData();
      carouselLoaded=true;
    }else{
      await loadData();
    }
    setLoading(90);
  }catch(e){showToast('Error loading '+mode+': '+e.message,'error');setLoading(0);}
  refreshOptionLists();
  renderStagePills();
  activeFilters.stage='';
  renderAll();
  setLoading(100);setTimeout(()=>setLoading(0),400);
  refreshDisplayUrls().then(()=>renderAll()).catch(()=>{});
}

async function uploadFile(file,subfolder){
  if(LOCAL_MODE){
    const isImage=file.type.startsWith('image/');
    let displayUrl;
    if(isImage){
      displayUrl=await new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsDataURL(file);});
    }else{
      displayUrl=URL.createObjectURL(file);
    }
    return{shareUrl:displayUrl,itemId:'local_'+uid(),downloadUrl:displayUrl};
  }
  await ensureSubfolder(subfolder);
  let res;
  if(file.size<4*1024*1024){
    res=await apiCall(`${await boardPath(subfolder,file.name)}:/content`,'PUT',file);
  }else{
    const session=await apiCall(`${await boardPath(subfolder,file.name)}:/createUploadSession`,'POST',{item:{['@microsoft.graph.conflictBehavior']:'rename'}});
    const chunkSize=320*1024*10;let start=0;
    while(start<file.size){
      const end=Math.min(start+chunkSize,file.size);
      const r=await fetch(session.uploadUrl,{method:'PUT',headers:{'Content-Range':`bytes ${start}-${end-1}/${file.size}`},body:file.slice(start,end)});
      const text=await r.text();
      if(!r.ok)throw new Error(text||`Upload failed: ${r.status}`);
      res=text?JSON.parse(text):null;start=end;
    }
  }
  if(!res||!res.id)throw new Error('Upload finished without an item id');
  // Use webUrl directly — createLink with scope:'organization' requires delegated token
  return{shareUrl:res.webUrl||null,itemId:res.id,downloadUrl:res['@microsoft.graph.downloadUrl']||null};
}

async function uploadFileWithProgress(file,subfolder,onProgress){
  if(LOCAL_MODE){
    onProgress?.(8);
    const result=await uploadFile(file,subfolder);
    onProgress?.(100);
    return result;
  }
  await ensureSubfolder(subfolder);
  let res;
  if(file.size<4*1024*1024){
    const token=await getToken();
    const url='https://graph.microsoft.com/v1.0'+`${await boardPath(subfolder,file.name)}:/content`;
    res=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open('PUT',url);
      xhr.setRequestHeader('Authorization','Bearer '+token);
      xhr.upload.onprogress=e=>{
        if(e.lengthComputable)onProgress?.(Math.max(1,Math.round((e.loaded/e.total)*100)));
      };
      xhr.onload=()=>{
        if(xhr.status>=200&&xhr.status<300){
          onProgress?.(100);
          try{resolve(xhr.responseText?JSON.parse(xhr.responseText):null);}
          catch(e){reject(e);}
        }else reject(new Error(xhr.responseText||`Upload failed: ${xhr.status}`));
      };
      xhr.onerror=()=>reject(new Error('Network upload failed'));
      xhr.send(file);
    });
  }else{
    const session=await apiCall(`${await boardPath(subfolder,file.name)}:/createUploadSession`,'POST',{item:{['@microsoft.graph.conflictBehavior']:'rename'}});
    const chunkSize=320*1024*10;let start=0;
    while(start<file.size){
      const end=Math.min(start+chunkSize,file.size);
      const r=await fetch(session.uploadUrl,{method:'PUT',headers:{'Content-Range':`bytes ${start}-${end-1}/${file.size}`},body:file.slice(start,end)});
      const text=await r.text();
      if(!r.ok)throw new Error(text||`Upload failed: ${r.status}`);
      res=text?JSON.parse(text):null;start=end;
      onProgress?.(Math.max(1,Math.round((start/file.size)*100)));
    }
  }
  if(!res||!res.id)throw new Error('Upload finished without an item id');
  return{shareUrl:res.webUrl||null,itemId:res.id,downloadUrl:res['@microsoft.graph.downloadUrl']||null};
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

function setActionButtonsDisabled(containerId,disabled){
  const container=document.getElementById(containerId);
  if(!container)return;
  container.querySelectorAll('button').forEach(btn=>{btn.disabled=disabled;});
}

async function fetchBlobWithProgress(url,onProgress){
  const res=await fetch(url);
  if(!res.ok)throw new Error(`Download failed: ${res.status}`);
  const total=parseInt(res.headers.get('Content-Length')||'0',10);
  if(!res.body||!total){
    onProgress?.(null);
    return res.blob();
  }
  const reader=res.body.getReader();
  const chunks=[];
  let loaded=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    chunks.push(value);
    loaded+=value.length;
    onProgress?.(Math.round((loaded/total)*100));
  }
  return new Blob(chunks,{type:res.headers.get('Content-Type')||'application/octet-stream'});
}

async function refreshDisplayUrls(){
  if(LOCAL_MODE)return;
  const now=Date.now();
  const needsRefresh=c=>!c._urlFetchedAt||(now-c._urlFetchedAt>DISPLAY_URL_TTL_MS);
  await mapLimit(cards,5,async c=>{
    if(!needsRefresh(c))return;
    if(c.thumbItemId){
      try{const m=await apiCall(await boardItemPath(c.thumbItemId));c.thumbDisplayUrl=m['@microsoft.graph.downloadUrl']||c.thumbDisplayUrl;}
      catch(e){if(c.thumbUrl){try{const m=await apiCall(`/shares/${encodeSharingUrl(c.thumbUrl)}/driveItem`);c.thumbItemId=m.remoteItem?.id||m.id;c.thumbDisplayUrl=(m.remoteItem&&m.remoteItem['@microsoft.graph.downloadUrl'])||m['@microsoft.graph.downloadUrl']||null;}catch(inner){}}}
    }else if(c.thumbUrl&&!c.thumbDisplayUrl){
      try{const m=await apiCall(`/shares/${encodeSharingUrl(c.thumbUrl)}/driveItem`);c.thumbItemId=m.remoteItem?.id||m.id;c.thumbDisplayUrl=(m.remoteItem&&m.remoteItem['@microsoft.graph.downloadUrl'])||m['@microsoft.graph.downloadUrl']||null;}catch(e){}
    }
    if(c.vidItemId){
      try{const m=await apiCall(await boardItemPath(c.vidItemId));c.vidDisplayUrl=m['@microsoft.graph.downloadUrl']||c.vidDisplayUrl;}
      catch(e){if(c.vidUrl){try{const m=await apiCall(`/shares/${encodeSharingUrl(c.vidUrl)}/driveItem`);c.vidItemId=m.remoteItem?.id||m.id;c.vidDisplayUrl=(m.remoteItem&&m.remoteItem['@microsoft.graph.downloadUrl'])||m['@microsoft.graph.downloadUrl']||null;}catch(inner){}}}
    }else if(c.vidUrl&&!c.vidDisplayUrl){
      try{const m=await apiCall(`/shares/${encodeSharingUrl(c.vidUrl)}/driveItem`);c.vidItemId=m.remoteItem?.id||m.id;c.vidDisplayUrl=(m.remoteItem&&m.remoteItem['@microsoft.graph.downloadUrl'])||m['@microsoft.graph.downloadUrl']||null;}catch(e){}
    }
    if(Array.isArray(c.images)&&c.images.length){
      await mapLimit(c.images,4,async img=>{
        if(img.itemId){try{const m=await apiCall(await boardItemPath(img.itemId));img.downloadUrl=m['@microsoft.graph.downloadUrl']||img.downloadUrl;}catch(e){}}
      });
    }
    c._urlFetchedAt=Date.now();
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
  if(!btn)return;
  const allowed=canManageSettings();
  btn.style.display=allowed?'':'none';
  btn.disabled=!allowed;
  if(!allowed&&document.getElementById('settingsBg').classList.contains('open'))closeSettings();
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
  document.getElementById('usersSettingsList').innerHTML=boardUsers.map((u,i)=>`
    <div class="user-row">
      <div>
        <div class="user-row-info">
          <span style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(u.username)}</span>
          <span class="user-badge ${u.role==='admin'?'admin':'user-role'}">${u.role}</span>
          ${u.mustChangePassword?'<span class="user-badge must-change">must change pw</span>':''}
          ${u.username===currentSession?.username?'<span style="font-size:10px;color:var(--text3)">(you)</span>':''}
        </div>
        <div class="user-actions" style="margin-top:6px">
          <button class="user-action-btn" onclick="toggleUserRole(${i})">${u.role==='admin'?'Make user':'Make admin'}</button>
          <button class="user-action-btn" onclick="resetUserPassword(${i})">Reset password</button>
          ${u.username!==currentSession?.username?`<button class="user-action-btn" style="color:#f87171;border-color:#7f1d1d" onclick="deleteUser(${i})">Delete</button>`:''}
        </div>
      </div>
    </div>`).join('');
}

async function toggleUserRole(i){
  if(!canManageSettings())return;
  boardUsers[i].role=boardUsers[i].role==='admin'?'user':'admin';
  try{await saveUsers();renderUsersSettings();showToast('Role updated','success');}
  catch(e){showToast('Error: '+e.message,'error');}
}

async function resetUserPassword(i){
  if(!canManageSettings())return;
  const u=boardUsers[i];
  const salt=generateSalt();
  boardUsers[i].passwordHash=await hashPassword(DEFAULT_PASSWORD,salt);
  boardUsers[i].salt=salt;
  boardUsers[i].mustChangePassword=true;
  try{await saveUsers();renderUsersSettings();showToast(`Password reset for ${u.username}`,'success');}
  catch(e){showToast('Error: '+e.message,'error');}
}

async function deleteUser(i){
  if(!canManageSettings())return;
  const u=boardUsers[i];
  if(u.username===currentSession?.username)return;
  boardUsers.splice(i,1);
  try{await saveUsers();renderUsersSettings();showToast(`${u.username} removed`,'success');}
  catch(e){showToast('Error: '+e.message,'error');}
}

async function addUser(){
  if(!canManageSettings())return;
  const nameEl=document.getElementById('newUserNameInput');
  const roleEl=document.getElementById('newUserRoleInput');
  const username=nameEl.value.trim().toLowerCase();
  if(!username)return;
  if(boardUsers.some(u=>u.username.toLowerCase()===username)){showToast('Username already exists','error');return;}
  const salt=generateSalt();
  const passwordHash=await hashPassword(DEFAULT_PASSWORD,salt);
  boardUsers.push({id:'u_'+uid(),username,passwordHash,salt,mustChangePassword:true,role:roleEl.value,createdAt:new Date().toISOString()});
  nameEl.value='';
  try{await saveUsers();renderUsersSettings();showToast(`${username} added`,'success');}
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
  const due=new Date(dueDate);due.setHours(0,0,0,0);
  const diff=Math.round((due-today)/(864e5));
  if(diff<0)return'overdue';
  if(diff<=3)return'soon';
  return null;
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
    if(f.q&&![c.name,c.channel,c.segment,c.presenter,c.assign,c.editor,c.seoTitle,c.seoDesc,c.script,c.notes].some(v=>v&&v.toLowerCase().includes(f.q)))return false;
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
  const thumbSrc=safeUrl(c.thumbDisplayUrl);
  const vidSrc=safeUrl(c.vidDisplayUrl);
  const dueSt=dueDateStatus(c.dueDate,c.stage);
  const thumbTile=thumbSrc
    ?`<div class="card-media-item has-file" title="Thumbnail preview" onclick="event.stopPropagation();openLightbox('img',${jsArg(thumbSrc)},${jsArg(c.name||'')})"><img src="${escHtml(thumbSrc)}" onerror="this.parentElement.classList.remove('has-file');this.parentElement.innerHTML='<div class=&quot;card-media-empty&quot;><svg viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.5&quot;><rect x=&quot;3&quot; y=&quot;5&quot; width=&quot;18&quot; height=&quot;14&quot; rx=&quot;2&quot;/><path d=&quot;M3 14l4-4 3 3 4-5 4 6&quot;/></svg><span>Thumbnail</span></div>'"><span class="card-media-caption">Thumbnail</span></div>`
    :`<div class="card-media-item" title="No thumbnail"><div class="card-media-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14l4-4 3 3 4-5 4 6"/></svg><span>Thumbnail</span></div></div>`;
  const isCarouselCard=boardMode==='carousels';
  let mediaSectionHtml;
  if(isCarouselCard){
    const imgs=Array.isArray(c.images)&&c.images.length?c.images:(c.thumbDisplayUrl?[{downloadUrl:c.thumbDisplayUrl,shareUrl:c.thumbUrl}]:[]);
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
    const videoTile=vidSrc
      ?`<div class="card-media-item has-file" title="Play video" onclick="event.stopPropagation();openLightbox('vid',${jsArg(vidSrc)},${jsArg(c.name||'')})"><div class="card-media-play" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px">▶</div><span class="card-media-caption">Video</span></div>`
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
    let va,vb;
    switch(sortBy){
      case'priority': va=PRI_ORDER[a.priority]??3; vb=PRI_ORDER[b.priority]??3; break;
      case'dueDate':  va=a.dueDate||'9999'; vb=b.dueDate||'9999'; break;
      case'postDate': va=a.postDate||'9999'; vb=b.postDate||'9999'; break;
      case'name':     va=(a.name||'').toLowerCase(); vb=(b.name||'').toLowerCase(); break;
      case'createdAt':va=a.id||''; vb=b.id||''; break;
      default:        va=PRI_ORDER[a.priority]??3; vb=PRI_ORDER[b.priority]??3;
    }
    if(va<vb)return -1*dir; if(va>vb)return 1*dir; return 0;
  });
}

function renderAll(){
  const bw=document.querySelector('.board-wrap');
  const sx=bw?bw.scrollLeft:0;
  const fc=getFiltered();
  renderStats(fc);
  document.getElementById('board').innerHTML=currentStages().map((s,i)=>{
    const stageCards=sortCards(fc.filter(c=>c.stage===i));
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
      if(card&&card.stage!==newStage){card.stage=newStage;renderAll();try{await saveData();}catch(err){showToast('Save failed: '+err.message,'error');}}
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
  const isCarousel=boardMode==='carousels';
  thumbOneDriveUrl=null;vidOneDriveUrl=null;
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
  thumbOneDriveUrl=c.thumbUrl||null;vidOneDriveUrl=c.vidUrl||null;
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
  const fScript=document.getElementById('fScript');fScript.value=c.script||'';fScript.style.height='auto';if(c.script)fScript.style.height=fScript.scrollHeight+'px';
  document.getElementById('fSeoTitle').value=c.seoTitle||'';
  const fSeoDesc=document.getElementById('fSeoDesc');fSeoDesc.value=c.seoDesc||'';fSeoDesc.style.height='auto';if(c.seoDesc)fSeoDesc.style.height=fSeoDesc.scrollHeight+'px';
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
    thumbItemId=c.thumbItemId||null;thumbDisplayUrl=c.thumbDisplayUrl||null;
    document.getElementById('thumbStatus').textContent='File uploaded ✓';
    document.getElementById('thumbLabel').textContent='Change image';
    const tv=safeUrl(c.thumbUrl);
    document.getElementById('thumbLink').innerHTML=tv?`<a href="${escHtml(tv)}" target="_blank" style="color:#3b82f6">View on OneDrive →</a>`:'';
    document.getElementById('thumbActions').style.display='flex';
    setPreview('thumb',thumbDisplayUrl,c.name);
  }
  if(c.vidUrl){
    vidItemId=c.vidItemId||null;vidDisplayUrl=c.vidDisplayUrl||null;
    document.getElementById('vidStatus').textContent='File uploaded ✓';
    document.getElementById('vidLabel').textContent='Change video';
    const vv=safeUrl(c.vidUrl);
    document.getElementById('vidLink').innerHTML=vv?`<a href="${escHtml(vv)}" target="_blank" style="color:#3b82f6">View on OneDrive →</a>`:'';
    document.getElementById('vidActions').style.display='flex';
    setPreview('vid',vidDisplayUrl,c.name);
  }
  document.getElementById('modalBg').classList.add('open');
}

function closeModal(){document.getElementById('modalBg').classList.remove('open');}

async function handleUpload(file,type){
  const statusEl=document.getElementById(type+'Status');
  const boxEl=document.getElementById(type+'Box');
  const linkEl=document.getElementById(type+'Link');
  setTransferStatus(statusEl,'Uploading',0);
  boxEl.classList.add('uploading');
  try{
    const result=await uploadFileWithProgress(file,type==='thumb'?'thumbnails':'videos',pct=>setTransferStatus(statusEl,'Uploading',pct));
    if(type==='thumb'){thumbOneDriveUrl=result.shareUrl;thumbItemId=result.itemId;thumbDisplayUrl=result.downloadUrl;}
    else{vidOneDriveUrl=result.shareUrl;vidItemId=result.itemId;vidDisplayUrl=result.downloadUrl;}
    setPlainStatus(statusEl,'Uploaded ✓');
    const rl=safeUrl(result.shareUrl);
    linkEl.innerHTML=rl?`<a href="${escHtml(rl)}" target="_blank" style="color:#3b82f6">View on OneDrive →</a>`:'';
    document.getElementById(type+'Actions').style.display='flex';
    setPreview(type,type==='thumb'?thumbDisplayUrl:vidDisplayUrl,document.getElementById('fName').value||'');
    showToast(LOCAL_MODE?'File saved locally':'File uploaded to OneDrive','success');
  }catch(e){setPlainStatus(statusEl,'Upload failed: '+e.message,'error');showToast('Upload failed','error');}
  boxEl.classList.remove('uploading');
}

async function downloadUpload(type){
  const url = type==='thumb' ? thumbDisplayUrl : vidDisplayUrl;
  const name = document.getElementById('fName').value || 'file';
  const ext = type==='thumb' ? '.jpg' : '.mp4';
  const statusEl=document.getElementById(type+'Status');
  if(!url){showToast('No file to download','error');return;}
  setActionButtonsDisabled(type+'Actions',true);
  setTransferStatus(statusEl,'Downloading',0);
  try{
    const blob = await fetchBlobWithProgress(url,pct=>{
      if(typeof pct==='number')setTransferStatus(statusEl,'Downloading',pct);
      else setTransferStatus(statusEl,'Downloading');
    });
    const realExt = blob.type.includes('png')?'.png':blob.type.includes('gif')?'.gif':blob.type.includes('mp4')?'.mp4':blob.type.includes('mov')?'.mov':ext;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name+'-'+(type==='thumb'?'thumbnail':'video')+realExt;
    a.click();
    URL.revokeObjectURL(a.href);
    setPlainStatus(statusEl,'Download started ✓');
    setTimeout(()=>{if(statusEl.textContent==='Download started ✓')setPlainStatus(statusEl,'File uploaded ✓');},1800);
  }catch(e){setPlainStatus(statusEl,'Download failed: '+e.message,'error');showToast('Download failed: '+e.message,'error');}
  setActionButtonsDisabled(type+'Actions',false);
}

async function removeUpload(type){
  const label = type==='thumb' ? 'thumbnail image' : 'video';
  if(!confirm(`Delete the uploaded ${label} from OneDrive? This cannot be undone.`)) return;
  const itemId = type==='thumb' ? thumbItemId : vidItemId;
  if(itemId && !LOCAL_MODE){
    try{
      await apiCall(await boardItemPath(itemId),'DELETE');
    }catch(e){
      // Ignore 404 (already deleted); fail on others
      if(e.status!==404) return showToast('Delete failed: '+e.message,'error');
    }
  }
  if(type==='thumb'){
    thumbOneDriveUrl=null;thumbItemId=null;thumbDisplayUrl=null;
    document.getElementById('thumbStatus').textContent='';
    document.getElementById('thumbLabel').textContent='Upload image';
    document.getElementById('thumbLink').innerHTML='';
    document.getElementById('thumbActions').style.display='none';
    const p=document.getElementById('thumbPreview');p.style.display='none';p.innerHTML='';
  }else{
    vidOneDriveUrl=null;vidItemId=null;vidDisplayUrl=null;
    document.getElementById('vidStatus').textContent='';
    document.getElementById('vidLabel').textContent='Upload video';
    document.getElementById('vidLink').innerHTML='';
    document.getElementById('vidActions').style.display='none';
    const p=document.getElementById('vidPreview');p.style.display='none';p.innerHTML='';
  }
  showToast('File deleted from OneDrive','success');
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
  carouselImages.splice(idx,1);
  renderCarouselImagesGrid();
}

async function downloadAllCarouselImages(){
  if(!carouselImages.length) return;
  const statusEl=document.getElementById('carouselImagesStatus');
  setActionButtonsDisabled('carouselDownloadAll',true);
  setTransferStatus(statusEl,`Downloading 0/${carouselImages.length}`,0);
  showToast(`Downloading ${carouselImages.length} image${carouselImages.length>1?'s':''}...`,'success');
  for(let i=0;i<carouselImages.length;i++){
    const img=carouselImages[i];
    const url=img.downloadUrl||img.shareUrl;
    if(!url) continue;
    // Fetch as blob to force download (avoids tab-open on direct URL)
    try{
      const blob=await fetchBlobWithProgress(url,pct=>{
        const base=Math.round((i/carouselImages.length)*100);
        const part=typeof pct==='number'?Math.round(pct/carouselImages.length):0;
        setTransferStatus(statusEl,`Downloading ${i+1}/${carouselImages.length}`,Math.min(100,base+part));
      });
      const ext=blob.type.includes('png')?'.png':blob.type.includes('gif')?'.gif':'.jpg';
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`slide-${i+1}${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      // Small delay between downloads to avoid browser blocking
      if(i<carouselImages.length-1) await new Promise(r=>setTimeout(r,400));
    }catch(e){showToast(`Failed to download slide ${i+1}`,'error');}
  }
  setPlainStatus(statusEl,`Download started for ${carouselImages.length} image${carouselImages.length>1?'s':''} ✓`);
  setActionButtonsDisabled('carouselDownloadAll',false);
}

async function handleCarouselImagesUpload(files){
  const statusEl=document.getElementById('carouselImagesStatus');
  const boxEl=document.getElementById('carouselAddImgBox');
  const total=files.length;
  setTransferStatus(statusEl,`Uploading 0/${total}`,0);
  boxEl.classList.add('uploading');
  let done=0;
  for(const file of files){
    try{
      const result=await uploadFileWithProgress(file,'thumbnails',pct=>{
        const base=Math.round((done/total)*100);
        const part=typeof pct==='number'?Math.round(pct/total):0;
        setTransferStatus(statusEl,`Uploading ${done+1}/${total}`,Math.min(100,base+part));
      });
      carouselImages.push({shareUrl:result.shareUrl,itemId:result.itemId,downloadUrl:result.downloadUrl});
      done++;
      if(done<total)setTransferStatus(statusEl,`Uploading ${done}/${total}`,Math.round((done/total)*100));
      else setPlainStatus(statusEl,`${done} image${done>1?'s':''} uploaded ✓`);
      renderCarouselImagesGrid();
    }catch(e){
      setPlainStatus(statusEl,`Failed on "${file.name}": ${e.message}`,'error');
    }
  }
  boxEl.classList.remove('uploading');
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
function showToastUndo(msg){
  const t=document.getElementById('toast');t.innerHTML='';
  const span=document.createElement('span');span.textContent=msg;
  const btn=document.createElement('button');btn.textContent='Undo';
  btn.style.cssText='margin-left:12px;background:none;border:1px solid currentColor;border-radius:4px;padding:2px 8px;font-size:12px;color:inherit;cursor:pointer;font-family:inherit';
  btn.addEventListener('click',async()=>{
    if(pendingDelete){
      clearTimeout(pendingDelete.timer);
      cards.splice(pendingDelete.index,0,pendingDelete.card);
      pendingDelete=null;
      renderAll();
      t.classList.remove('show');
      try{await saveData();}catch(e){showToast('Undo save failed: '+e.message,'error');}
    }
  });
  const bar=document.createElement('div');bar.className='toast-bar';
  t.appendChild(span);t.appendChild(btn);t.appendChild(bar);
  t.className='toast show';
  setTimeout(()=>{if(!pendingDelete)t.classList.remove('show');},5000);
}

// ========== REPORTS ==========
let reportPeriod = 'all';

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
  return {from:'', to:''};
}

function localDateStr(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function filterCardsByPeriod(from, to) {
  if (!from && !to) return cards;
  return cards.filter(c => {
    const created = localDateStr(c.createdAt);
    if (!created) return false;
    if (from && created < from) return false;
    if (to   && created > to)   return false;
    return true;
  });
}

function barColor(label) {
  const map = {High:'#f87171',Medium:'#e8a83b',Low:'#5ae8a0',Approved:'#5ae8a0',Pending:'#e8a83b',Rejected:'#f87171',Short:'#7ab8e8',Long:'#e8a07a',Overdue:'#f87171','Due soon':'#e8a83b','On-time':'#5ae8a0'};
  return map[label] || '#3b82f6';
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

function renderReport() {
  const r = computeReport();
  const {from, to} = getReportRange();
  const periodLabel = reportPeriod === 'all' ? 'All time' :
    reportPeriod === 'today' ? 'Today' :
    reportPeriod === 'week'  ? 'This week' :
    reportPeriod === 'month' ? 'This month' :
    (from||'?') + ' → ' + (to||'?');
  const tot = r.total || 1;

  document.getElementById('reportsBody').innerHTML = `
    <div class="report-period-note">
      <span style="color:var(--text2);font-weight:500">${boardMode==='carousels'?'Carousels':'Videos'}</span>
      &nbsp;·&nbsp; Period: <strong style="color:var(--text)">${escHtml(periodLabel)}</strong>
      &nbsp;·&nbsp; ${r.total} ${boardMode==='carousels'?'carousel':'video'}${r.total!==1?'s':''} in scope
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

function openReports() {
  document.getElementById('reportsOverlay').classList.add('open');
  renderReport();
}
function closeReports() { document.getElementById('reportsOverlay').classList.remove('open'); }

function exportCSV() {
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

// ========== EVENT LISTENERS ==========
document.getElementById('loginSubmitBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('loginUsername').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('loginPassword').focus(); });

document.getElementById('changePwSubmitBtn').addEventListener('click', doChangePassword);
document.getElementById('changePwConfirm').addEventListener('keydown', e=>{ if(e.key==='Enter') doChangePassword(); });

document.getElementById('msConnectBtn').addEventListener('click', async()=>{
  document.getElementById('msConnectError').textContent='';
  document.getElementById('msConnectBtn').disabled=true;
  document.getElementById('msConnectBtn').textContent='Connecting...';
  try{
    cachedToken=null; tokenExpiresAt=0;
    await getToken();
    location.reload();
  }catch(e){
    document.getElementById('msConnectError').textContent='Connection failed: '+e.message;
    document.getElementById('msConnectBtn').disabled=false;
    document.getElementById('msConnectBtn').innerHTML='<svg class="ms-icon" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>Connect Service Account';
  }
});


document.getElementById('userAvatar').addEventListener('click', doLogout);

document.getElementById('thumbFile').addEventListener('change',function(){if(this.files[0])handleUpload(this.files[0],'thumb');});
document.getElementById('vidFile').addEventListener('change',function(){if(this.files[0])handleUpload(this.files[0],'vid');});
document.getElementById('carouselImagesFile').addEventListener('change',function(){if(this.files.length)handleCarouselImagesUpload(Array.from(this.files));this.value='';});

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
    slidesCount:boardMode==='carousels'?(parseInt(document.getElementById('fSlidesCount').value)||null):undefined,
    thumbUrl: boardMode==='carousels' ? (carouselImages[0]?.shareUrl||null) : thumbOneDriveUrl,
    thumbItemId: boardMode==='carousels' ? (carouselImages[0]?.itemId||null) : thumbItemId,
    thumbDisplayUrl: boardMode==='carousels' ? (carouselImages[0]?.downloadUrl||null) : thumbDisplayUrl,
    vidUrl: boardMode==='carousels' ? undefined : vidOneDriveUrl,
    vidItemId: boardMode==='carousels' ? undefined : vidItemId,
    vidDisplayUrl: boardMode==='carousels' ? undefined : vidDisplayUrl,
    images: boardMode==='carousels' ? carouselImages.map(img=>({shareUrl:img.shareUrl,itemId:img.itemId||null,downloadUrl:img.downloadUrl||null})) : undefined
  };
  const btn=document.getElementById('saveBtn');
  btn.textContent='Saving...';btn.disabled=true;
  try{
    if(editId){const idx=cards.findIndex(c=>c.id===editId);cards[idx]=card;}else{cards.push(card);}
    await saveData();closeModal();renderAll();showToast(boardMode==='carousels'?'Carousel saved':'Video saved','success');
  }catch(e){showToast('Save failed: '+e.message,'error');}
  btn.textContent='Save';btn.disabled=false;
});

document.getElementById('deleteBtn').addEventListener('click',async()=>{
  if(!editId)return;
  const cardToDelete=cards.find(c=>c.id===editId);if(!cardToDelete)return;
  const originalIndex=cards.indexOf(cardToDelete);
  if(pendingDelete){clearTimeout(pendingDelete.timer);pendingDelete=null;try{await saveData();}catch(e){}}
  cards=cards.filter(c=>c.id!==editId);
  closeModal();renderAll();
  pendingDelete={card:cardToDelete,index:originalIndex,timer:setTimeout(async()=>{pendingDelete=null;try{await saveData();}catch(e){showToast('Delete failed: '+e.message,'error');}},5000)};
  showToastUndo('"'+cardToDelete.name+'" deleted');
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
document.getElementById('addUserBtn').addEventListener('click',addUser);
document.getElementById('newPersonName').addEventListener('keydown',e=>{if(e.key==='Enter')addSettingsPerson();});
document.getElementById('newCategoryName').addEventListener('keydown',e=>{if(e.key==='Enter')addSettingsCategory();});
document.getElementById('newUserNameInput').addEventListener('keydown',e=>{if(e.key==='Enter')addUser();});
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
document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
document.getElementById('printReportBtn').addEventListener('click', () => window.print());
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reportPeriod = btn.dataset.period;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('reportCustomDates').style.display = reportPeriod === 'custom' ? 'flex' : 'none';
    renderReport();
  });
});
document.getElementById('reportFromDate').addEventListener('change', renderReport);
document.getElementById('reportToDate').addEventListener('change', renderReport);

document.getElementById('lightboxClose').addEventListener('click',closeLightbox);
document.getElementById('lightbox').addEventListener('click',function(e){if(e.target===this)closeLightbox();});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeLightbox();if(document.getElementById('settingsBg').classList.contains('open'))closeSettings();}
});

init().catch(e=>console.error(e));
