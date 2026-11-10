import { pollDelay } from './polling.mjs';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const app = $('#app');
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won = n => Number(n).toLocaleString('ko-KR')+'원';
const date = (n, short = false) => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:short?undefined:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:short?undefined:'2-digit',minute:short?undefined:'2-digit',hour12:false}).format(n);
const icon = (name, size=20) => {
  const paths = { arrow:'M5 12h14m-6-6 6 6-6 6', search:'m21 21-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0', ticket:'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Zm12 0v3m0 3v2m0 3v3', pin:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0', check:'m5 12 4 4L19 6', clock:'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0', back:'m14 6-6 6 6 6', plus:'M12 5v14M5 12h14', lock:'M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4', music:'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3c2 0 3 1 3 3Zm12-2a3 3 0 1 1-3-3c2 0 3 1 3 3' };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.ticket}"/></svg>`;
};
let session = {user:null,csrf:null,demo:false}, concerts = [], revision = 0, poll = null, tick = null, bookingView = null;
let queueController = null;
let returnTo = '#/';
let toastTimeout;
function toast(message) { const box=$('#toast');box.textContent=message;box.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>box.hidden=true,4500); }
async function api(path, options = {}) {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(session.csrf ? {'X-CSRF-Token':session.csrf} : {}), ...options.headers };
  const res = await fetch(path,{...options,headers,credentials:'same-origin',body: options.body ? JSON.stringify(options.body):undefined});
  let data; try {data=await res.json();} catch { throw new Error('서버 응답을 확인할 수 없습니다. 다시 시도해 주세요.'); }
  if(!res.ok) {if(res.status===401&&!path.startsWith('/api/auth/')){session={...session,user:null,csrf:null};account();}const e=new Error(data.error);e.status=res.status;e.code=data.code;e.retryAfter=Number(res.headers.get('Retry-After'))||0;throw e;} return data;
}
function account() {
  $('#account').innerHTML=session.user ? `${session.user.role==='admin'?'<a class="admin-link" href="#/admin">관리자</a>':'<a class="text-button" href="#/account">계정 관리</a>'}<span class="user-name">${escape(session.user.name)}님</span><button class="text-button" id="logout">로그아웃</button>` : '<a class="text-button" href="#/login">로그인</a><a class="button small" href="#/signup">회원가입</a>';
  $('#logout')?.addEventListener('click',async()=>{try {await api('/api/auth/logout',{method:'POST'});session={...session,user:null,csrf:null};account();if(location.hash==='#/'||!location.hash)await route();else location.hash='#/';toast('로그아웃했어요.');}catch(e){toast(e.message);}});
}
function theme(c) {return ['teal','purple','orange','blue'].includes(c.theme)?c.theme:'teal';}
// null = registered before opening times existed (no restriction). The server re-checks every hold/queue entry.
const bookingClosedUntilOpen = c => c.booking_opens_at != null && c.booking_opens_at > Date.now();
const salesLabel = c => bookingClosedUntilOpen(c) ? '<span class="available-dot soon">오픈 예정</span>' : `<span class="available-dot">${c.performances.some(p=>p.starts_at>Date.now()&&p.available)?'예매 중':'예매 마감'}</span>`;
function poster(c, extra='') {
  const words = c.title.split(' : ');
  return `<div class="poster ${theme(c)} ${extra}" aria-label="${escape(c.title)} 포스터"><span class="poster-top">ticket-ssu LIVE SERIES · 2026</span><div class="poster-art"><i></i><i></i><i></i><i></i></div><div class="poster-title">${escape(words[0])}<small>${escape(words[1]||'LIVE IN CONCERT')}</small></div><div class="poster-bottom"><span>${escape(c.artist)}</span><span>LIVE<br>ON STAGE ↗</span></div></div>`;
}
const loading = () => '<div class="loading"><span class="spinner"></span>잠시만 기다려 주세요…</div>';
function requireAuth() {
  if(session.user) return true;
  returnTo=location.hash; location.hash='#/login'; return false;
}
function title(kicker,heading,description='') {return `<div class="page-heading"><span class="eyebrow">${kicker}</span><h1>${heading}</h1>${description?`<p>${description}</p>`:''}</div>`;}
function empty(message,link='공연 둘러보기') {return `<div class="empty">${icon('ticket',40)}<h3>${message}</h3><a class="button" href="#/">${link}${icon('arrow')}</a></div>`;}

async function home() {
  app.innerHTML=`<div class="container home"><section class="hero"><div class="hero-copy"><span class="hero-label"><span></span>MAKE TIME FOR LIVE</span><h1>그 순간의 설렘을,<br>당신의 <em>티켓</em>으로.</h1><p>기다려온 목소리, 함께 부르는 노래.<br>일상에 오래 남을 라이브를 만나보세요.</p><a class="button light" href="#concert-list">공연 찾아보기 ${icon('arrow')}</a></div><div class="hero-visual" aria-hidden="true"><div class="orbit one"></div><div class="orbit two"></div><div class="orbit three"></div><span class="hero-star">✳</span><div class="hero-ticket"><span>ticket-ssu LIVE</span><strong>AURORA</strong><p>THE MOMENT IS YOURS</p><div class="ticket-rule"></div><div class="ticket-mini"><span>ADMIT ONE<br><b>LIVE CONCERT</b></span>${icon('ticket',38)}</div></div><span class="hero-caption">GOOD MUSIC.<br>GREAT MEMORIES.</span></div><span class="hero-index">01 <i></i> 04</span></section>
    <div class="notice"><span class="pill neutral">이용 안내</span><p>ticket-ssu에서 공연을 고르고, 나만의 좌석을 예매해 보세요.</p><span class="desktop-only">LIVE BETTER, TOGETHER ↗</span></div>
    <section id="concert-list" class="concert-section"><div class="section-head"><div><span class="eyebrow">FIND YOUR NEXT MOMENT</span><h2>지금 만나고 싶은 공연</h2></div><span id="result-count" class="muted"></span></div><div class="filters"><div class="filter-tabs" role="group" aria-label="지역 필터">${['전체','서울','부산','인천'].map((s,i)=>`<button class="filter-tab ${i===0?'active':''}" data-region="${s}" aria-pressed="${i===0}">${s}</button>`).join('')}</div><div class="filter-controls"><label class="search">${icon('search')}<input id="search" type="search" placeholder="공연, 아티스트 검색" aria-label="공연 검색"></label><select id="sort" aria-label="정렬"><option value="date">공연일순</option><option value="price">낮은 가격순</option></select></div></div><div class="concert-grid" id="concert-grid">${loading()}</div></section><section class="bottom-note"><div class="note-icon">${icon('music',28)}</div><div><h3>좋아하는 음악에 한 걸음 더 가까이</h3><p>공연 일정과 좌석을 확인하고, 나의 티켓에서 예매를 관리하세요.</p></div><a href="#/bookings" class="text-link">나의 티켓 ${icon('arrow')}</a></section></div>`;
  const hashBefore=location.hash;
  const result=await api('/api/concerts'); concerts=result.concerts;
  if(location.hash!==hashBefore)return;
  let region='전체';
  function renderCards() {
    if(!$('#concert-grid'))return;
    const query=$('#search').value.toLowerCase().trim();
    const list=concerts.filter(c=>(region==='전체'||c.venue.includes(region))&&`${c.title} ${c.artist} ${c.venue}`.toLowerCase().includes(query));
    list.sort((a,b)=>$('#sort').value==='price'?a.performances[0].min_price-b.performances[0].min_price:a.performances[0].starts_at-b.performances[0].starts_at);
    $('#result-count').textContent=`총 ${list.length}개의 공연`;
    $('#concert-grid').innerHTML=list.length?list.map(c=>`<a class="concert-card" href="#/concert/${c.id}">${poster(c)}<div class="card-info"><div class="card-label"><span>콘서트</span>${salesLabel(c)}</div><h3>${escape(c.title)}</h3><p>${escape(c.venue)}</p><p>${date(c.performances[0].starts_at,true)} — ${date(c.performances.at(-1).starts_at,true)}</p><div class="card-price"><b>${won(c.performances[0].min_price)}<small>부터</small></b><span>${icon('arrow',18)}</span></div></div></a>`).join(''):'<div class="empty wide"><h3>검색 결과가 없어요.</h3><p>다른 검색어나 지역을 선택해 주세요.</p></div>';
  }
  $$('.filter-tab').forEach(button=>button.addEventListener('click',()=>{region=button.dataset.region;$$('.filter-tab').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',b===button);});renderCards();}));
  $('#search').addEventListener('input',renderCards);$('#sort').addEventListener('change',renderCards);renderCards();
  // An in-page anchor should not replace the application's hash route.
  $('.hero .button').addEventListener('click',e=>{e.preventDefault();$('#concert-list').scrollIntoView({behavior:'smooth'});});
}

async function concertDetail(id) {
  const r=revision; if(!concerts.length)concerts=(await api('/api/concerts')).concerts;if(r!==revision)return;
  const c=concerts.find(c=>c.id===id);if(!c)throw new Error('공연을 찾을 수 없습니다.');
  const firstOpen=c.performances.find(p=>p.starts_at>Date.now())?.id;
  const notOpen=bookingClosedUntilOpen(c);
  app.innerHTML=`<div class="container"><a class="back-link" href="#/">${icon('back')}공연 목록</a><div class="detail-layout"><div class="detail-poster">${poster(c)}</div><section class="detail-info"><span class="eyebrow">ticket-ssu LIVE · 콘서트</span><h1>${escape(c.title)}</h1><p class="artist-name">${escape(c.artist)}</p><dl class="info-list"><div><dt>장소</dt><dd>${escape(c.venue)}</dd></div><div><dt>공연 기간</dt><dd>${date(c.performances[0].starts_at,true)} ~ ${date(c.performances.at(-1).starts_at,true)}</dd></div><div><dt>관람 시간</dt><dd>${c.duration}분</dd></div><div><dt>관람 등급</dt><dd>${escape(c.age)}</dd></div><div><dt>매수 제한</dt><dd>1인 회차당 최대 4매</dd></div>${c.booking_opens_at!=null?`<div><dt>예매 오픈</dt><dd>${date(c.booking_opens_at)}</dd></div>`:''}</dl><h3>좌석 등급별 가격</h3><div class="price-grades"><span><i class="swatch vip"></i>VIP <b>${won(c.performances[0].min_price+40000)}</b></span><span><i class="swatch r"></i>R <b>${won(c.performances[0].min_price+20000)}</b></span><span><i class="swatch s"></i>S <b>${won(c.performances[0].min_price)}</b></span></div><p class="caption">예매 수수료 장당 2,000원 별도</p></section><aside class="panel schedule"><span class="eyebrow">BOOK YOUR MOMENT</span><h2>관람일 · 회차 선택</h2><div class="schedule-options">${c.performances.map(p=>`<label class="schedule-option"><input type="radio" name="performance" value="${p.id}" ${p.id===firstOpen?'checked':''} ${p.starts_at<=Date.now()?'disabled':''}><span><b>${date(p.starts_at)}</b><small>잔여 ${p.available}석${p.starts_at<=Date.now()?' · 마감':''}</small></span></label>`).join('')}</div><div class="schedule-policy">${icon('clock',17)}${notOpen?'예매 오픈 시각부터 좌석을 선택할 수 있습니다.':'좌석 선택 후 7분간 선점됩니다.'}</div><button id="start-booking" class="button full" ${firstOpen&&!notOpen?'':'disabled'}>${notOpen?`${escape(date(c.booking_opens_at))} 오픈`:'좌석 선택하기'} ${icon('arrow')}</button><p class="caption center">공연 시작 전까지 예매 · 취소 가능</p></aside></div><section class="detail-notice"><h2>공연 소개</h2><p>${escape(c.description)}</p><h3>예매 전 확인해 주세요</h3><ul><li>좌석 선택은 로그인 후 가능하며, 회차당 최대 4매까지 예매할 수 있습니다.</li><li>선점 시간이 지나면 선택 좌석이 자동으로 해제됩니다.</li><li>ticket-ssu는 데모 서비스입니다. 실제 결제나 티켓 발권은 이루어지지 않습니다.</li><li>공연 시작 전까지 취소 가능하며, 데모에서는 전액 취소됩니다.</li></ul></section></div>`;
  $('#start-booking').addEventListener('click',()=>{const pid=$('input[name=performance]:checked')?.value;if(!pid){toast('예매 가능한 회차를 선택해 주세요.');return;}returnTo=`#/book/${pid}`;location.hash=session.user?returnTo:'#/login';});
  // Re-render at the opening moment; route() clears this timer on navigation. setTimeout caps near 24.8 days.
  const untilOpen=notOpen?c.booking_opens_at-Date.now():0;
  if(notOpen&&untilOpen<2**31-1000) tick=setTimeout(()=>{concerts=[];route();},untilOpen+500);
}

function authPage(signup=false) {
  app.innerHTML=`<div class="auth-layout"><section class="auth-intro"><span class="eyebrow">YOUR NEXT GREAT MEMORY</span><h1>다음 장면은,<br>당신의 자리에서.</h1><div class="auth-art" aria-hidden="true">${icon('ticket',110)}<span>ticket-ssu</span></div><p>좋아하는 아티스트와 마주하는 순간.<br>ticket-ssu와 함께 시작하세요.</p></section><section class="auth-form"><span class="eyebrow">WELCOME TO ticket-ssu</span><h2>${signup?'회원가입':'다시 만나 반가워요'}</h2><p>${signup?'새로운 설렘을 만날 준비가 되셨나요?':'로그인하고 나만의 공연을 만나보세요.'}</p><form id="auth-form"><div class="form-error" role="alert" hidden></div>${signup?'<label>이름<input name="name" autocomplete="name" minlength="2" maxlength="40" required placeholder="이름을 입력해 주세요"></label>':''}<label>이메일<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="example@email.com"></label>${signup?'<label>휴대폰 번호<input name="phone" type="tel" autocomplete="tel" required pattern="01[016789][- ]?[0-9]{3,4}[- ]?[0-9]{4}" placeholder="010-1234-5678"></label>':''}<label>비밀번호<input name="password" type="password" autocomplete="${signup?'new-password':'current-password'}" minlength="${signup?10:1}" maxlength="128" required placeholder="${signup?'10자 이상 입력해 주세요':'비밀번호를 입력해 주세요'}"></label>${signup?'<label>비밀번호 확인<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required placeholder="비밀번호를 다시 입력해 주세요"></label><div class="agreements"><label class="check-label"><input type="checkbox" name="terms" required><span>[필수] 이용약관 및 개인정보 수집에 동의합니다.</span></label><details><summary>약관 및 개인정보 안내</summary><p>ticket-ssu 데모 회원가입과 예매 처리를 위해 이름, 이메일, 휴대폰 번호 및 비밀번호 해시를 로컬 DB에 저장합니다. 입력한 연락처로 메시지를 보내지 않습니다. 실제 서비스 운영 전 별도의 이용약관과 개인정보 처리방침이 필요합니다.</p></details><label class="check-label"><input type="checkbox" name="ageConfirmed" required><span>[필수] 만 14세 이상입니다.</span></label></div>':''}<button class="button full" type="submit">${signup?'가입하고 시작하기':'로그인'} ${icon('arrow')}</button></form><p class="auth-switch">${signup?'이미 ticket-ssu 회원이신가요?':'아직 ticket-ssu 회원이 아니신가요?'} <a href="#/${signup?'login':'signup'}">${signup?'로그인':'회원가입'}</a></p>${!signup&&session.demo?'<div class="demo-box"><b>빠르게 둘러보기</b><p>테스트 계정 정보를 입력해 드려요.</p><div class="actions"><button class="button secondary small" data-demo="user">일반 회원</button><button class="button secondary small" data-demo="admin">관리자</button></div></div>':''}<p class="caption">ticket-ssu 계정은 NOL 계정과 연동되지 않습니다.</p></section></div>`;
  const form=$('#auth-form');
  form.addEventListener('submit',async e=>{
    e.preventDefault();const data=Object.fromEntries(new FormData(form));const error=$('.form-error',form);error.hidden=true;
    if(signup&&data.password!==data.passwordConfirm){error.textContent='비밀번호가 일치하지 않습니다.';error.hidden=false;return;}
    data.terms=data.terms==='on';data.ageConfirmed=data.ageConfirmed==='on';delete data.passwordConfirm;
    const button=$('button[type=submit]',form);button.disabled=true;
    try {const next=await api(`/api/auth/${signup?'signup':'login'}`,{method:'POST',body:data});session={...session,...next};account();location.hash=returnTo.startsWith('#/')&&!['#/login','#/signup'].includes(returnTo)?returnTo:'#/';toast(signup?'ticket-ssu에 오신 것을 환영해요.':'로그인했어요.');}
    catch(e){error.textContent=e.message;error.hidden=false;button.disabled=false;}
  });
  $$('[data-demo]').forEach(b=>b.addEventListener('click',()=>{const admin=b.dataset.demo==='admin';form.elements.email.value=admin?'admin@ticket-ssu.local':'demo@ticket-ssu.local';form.elements.password.value=admin?'TicketSsuAdmin123!':'TicketSsuDemo123!';$('button[type=submit]',form).focus();}));
}

function seatGrid(map,admin=false,selected=new Set()) {
  return `<div class="seat-map-scroll"><div class="seat-map"><div class="stage">STAGE<span>무대</span></div><div class="zone-labels"><span>LEFT</span><span>CENTER</span><span>RIGHT</span></div><div class="seats">${Array.from({length:8},(_,r)=>{const row=String.fromCharCode(65+r);return `<div class="seat-row"><span class="row-label">${row}</span>${map.seats.filter(s=>s.row===row).map(s=>{const unavailable=admin?['held','selected','booked'].includes(s.state):!['available','selected'].includes(s.state);const checked=admin?selected.has(s.id):s.state==='selected';const labels={available:'예매 가능',selected:'내 선택',held:'선점 중',booked:'예매 완료',blocked:'판매 차단'};return `<button type="button" class="seat ${s.grade.toLowerCase()} ${s.state} ${checked?'chosen':''}" data-seat="${s.id}" aria-label="${s.id} ${s.grade}석 ${won(s.price)} ${labels[s.state]}" aria-pressed="${checked}" ${unavailable?'disabled':''} title="${s.id} · ${s.grade} · ${labels[s.state]}">${s.number}</button>`;}).join('')}<span class="row-label">${row}</span></div>`;}).join('')}</div><p class="seat-map-caption">각 열의 번호는 왼쪽에서 오른쪽 순서입니다.</p></div></div>`;
}
const seatLegend = `<div class="legend"><span><i class="swatch vip"></i>VIP</span><span><i class="swatch r"></i>R</span><span><i class="swatch s"></i>S</span><span><i class="swatch chosen"></i>선택</span><span><i class="swatch unavailable"></i>선점 / 예매 / 차단</span></div>`;
function selectedSeats() {return bookingView?.map.seats.filter(s=>s.state==='selected')||[];}
function updateSeatPanel() {
  const v=bookingView;if(!v||v.stage!=='seats')return;
  $('#map').innerHTML=seatGrid(v.map);
  const seats=selectedSeats(),total=seats.reduce((n,s)=>n+s.price+2000,0);
  $('#selected-list').innerHTML=seats.length?seats.map(s=>`<div class="selected-seat"><span><i class="swatch ${s.grade.toLowerCase()}"></i><b>${s.grade}</b> ${s.id}</span><button class="remove-seat" data-remove="${s.id}" aria-label="${s.id} 선택 해제">×</button></div>`).join(''):'<p class="selection-empty">좌석을 선택해 주세요.<br><small>최대 4석까지 선택할 수 있어요.</small></p>';
  $('#seat-count').textContent=`${seats.length} / 4`;
  $('#ticket-price').textContent=won(total-seats.length*2000);$('#fee-price').textContent=won(seats.length*2000);$('#total-price').textContent=won(total);
  $('#next-step').disabled=!seats.length||v.busy;
  $$('[data-seat]').forEach(b=>{b.disabled=b.disabled||v.busy||v.queue?.mode==='hold-recovery';b.addEventListener('click',()=>toggleSeat(b.dataset.seat));});
  $$('[data-remove]').forEach(b=>{b.disabled=v.busy||v.queue?.mode==='hold-recovery';b.addEventListener('click',()=>toggleSeat(b.dataset.remove));});
  updateTimer();
}
async function toggleSeat(id) {
  const v=bookingView;if(!v||v.busy||v.queue?.mode==='hold-recovery')return;const ids=selectedSeats().map(s=>s.id);
  if(ids.includes(id))ids.splice(ids.indexOf(id),1);else {if(ids.length>=4){toast('최대 4석까지 선택할 수 있어요.');return;}ids.push(id);}
  v.busy=true;v.mutation++;updateSeatPanel();
  try {await api(`/api/performances/${v.id}/hold`,{method:'PUT',headers:{'X-Admission-Token':v.queue.admission_token},body:{seatIds:ids}});const map=await api(`/api/performances/${v.id}/seats`);if(bookingView===v){v.map=map;v.offset=map.server_now-Date.now();v.expired=false;}}
  catch(e){toast(e.message);try {const map=await api(`/api/performances/${v.id}/seats`);if(bookingView===v){v.map=map;v.offset=map.server_now-Date.now();}}catch{}}
  finally {v.busy=false;if(bookingView===v)updateSeatPanel();}
}
function updateTimer() {
  const v=bookingView,box=$('#hold-timer');if(!v||!box)return;
  if(!v.map.hold){box.textContent='좌석 선택 후 7분 선점';box.classList.remove('urgent');return;}
  const left=Math.max(0,Math.ceil((v.map.hold.expires_at-Date.now()-v.offset)/1000));
  box.textContent=`선점 남은 시간 ${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`;box.classList.toggle('urgent',left<60);
  if(!left&&!v.expired&&!v.busy){v.expired=true;v.map.hold=null;v.map.seats.forEach(s=>{if(s.state==='selected')s.state='available';});v.stage='seats';renderBooking();toast('선점 시간이 만료되었어요. 좌석을 다시 선택해 주세요.');}
}
async function bookingPage(id) {
  if(!requireAuth())return;
  const r=revision,map=await api(`/api/performances/${id}/seats`);if(r!==revision)return;
  clearInterval(poll);clearInterval(tick);queueController?.abort();queueController=new AbortController();
  const v=bookingView={id,map,stage:'queue',busy:false,mutation:0,offset:map.server_now-Date.now(),expired:false,queue:null};
  const queuePath=`/api/v1/performances/${id}/queue`;let failures=0;
  const showQueue=(message='')=>{
    if(bookingView!==v)return;
    const waiting=v.queue?.state==='waiting';
    app.innerHTML=`<div class="container booking-page">${title('WAITING FOR YOUR TURN','예매 대기열',escape(map.performance.title))}<section class="panel checkout-panel" aria-live="polite"><h2>${waiting?`대기 순번 ${v.queue.position}번`:'입장 순서를 확인하고 있어요'}</h2><p>${waiting?`앞에 ${v.queue.ahead}명이 기다리고 있습니다. 입장할 수 있으면 자동으로 좌석 선택 화면으로 이동합니다.`:escape(message||'잠시만 기다려 주세요.')}</p><p class="caption">다른 회원의 이용 시간에 따라 대기시간이 달라집니다. 서버가 재시작되면 대기 순서가 사라집니다. 선점한 좌석은 남은 선점 시간 안에서 다시 확인할 수 있습니다.</p>${message&&waiting?`<p role="alert">${escape(message)}</p>`:''}<button class="button secondary" id="leave-queue">대기 나가기</button></section></div>`;
    $('#leave-queue').onclick=async()=>{try{await api(queuePath,{method:'DELETE'});location.hash=`#/concert/${map.performance.concert_id}`;}catch(e){toast(e.message);}};
  };
  const check=async(enter=false)=>{
    if(bookingView!==v)return;
    if(document.hidden){poll=setTimeout(()=>check(enter),pollDelay());return;}
    try {
      const status=await api(queuePath,{...(enter?{method:'POST',body:map.hold?{resumeHoldId:map.hold.id}:{}}:{}),signal:queueController.signal});
      if(bookingView!==v)return;v.queue=status;failures=0;
      if(status.state==='admitted'){await startBooking(v);return;}
      showQueue();poll=setTimeout(()=>check(),pollDelay());
    }catch(e){
      if(bookingView!==v||e.name==='AbortError')return;
      if(e.status===401){requireAuth();return;}
      if(e.code==='BOOKING_NOT_OPEN'){toast(`예매 오픈 전입니다. ${map.performance.booking_opens_at!=null?date(map.performance.booking_opens_at)+'에 열려요.':''}`);concerts=[];location.hash=`#/concert/${map.performance.concert_id}`;return;}
      showQueue(e.message);
      // Re-enter after expiry/restart/session replacement; an old valid hold is
      // resolved by the server, not converted into fresh seat-selection rights.
      const retryRecovery=e.status===409&&!!map.hold;
      if(e.status===409)map.hold=null;
      if(e.status===400||e.status===409&&!retryRecovery)return;
      failures++;poll=setTimeout(()=>check(enter||[403,404,409].includes(e.status)),pollDelay(failures,e.retryAfter));
    }
  };
  showQueue();await check(true);
}
async function startBooking(v) {
  const {id}=v;
  const map=await api(`/api/performances/${id}/seats`);if(bookingView!==v)return;
  v.map=map;v.offset=map.server_now-Date.now();v.stage='seats';renderBooking();
  tick=setInterval(updateTimer,1000);
  let failures=0;
  const refresh=async()=>{
    if(bookingView!==v)return;
    if(v.busy||v.polling||document.hidden){poll=setTimeout(refresh,pollDelay());return;}
    let retryAfter=0;
    v.polling=true;const mutation=v.mutation;
    try {
      const status=await api(`/api/v1/performances/${id}/queue`);if(bookingView!==v)return;
      const changedMode=status.mode!==v.queue.mode;v.queue=status;
      const map=await api(`/api/performances/${id}/seats`);if(bookingView!==v||v.busy||mutation!==v.mutation)return;
      const previous=v.map.hold?.id;v.map=map;v.offset=map.server_now-Date.now();
      if(previous&&previous!==map.hold?.id){v.stage='seats';renderBooking();toast('좌석 선점 상태가 변경되었어요. 다시 선택해 주세요.');}
      else if(changedMode&&v.stage==='seats')renderBooking();
      else if(v.stage==='seats')updateSeatPanel();
      const entry=$('#admission-note');if(entry)entry.textContent=status.mode==='hold-recovery'?'입장 시간이 끝났습니다. 현재 선점의 확정 또는 선택 초기화만 가능합니다.':'입장 완료 · 좌석 선택 시간이 끝나도 유효한 선점은 확정할 수 있습니다.';
      const sync=$('#sync-state');if(sync)sync.textContent='좌석 현황 동기화 중 · 약 3초 간격';
      failures=0;
    }catch(e){if(bookingView!==v)return;if(e.status===401){requireAuth();return;}if([403,404].includes(e.status)){toast('입장 상태를 다시 확인합니다.');await bookingPage(id);return;}failures++;retryAfter=e.retryAfter||0;const sync=$('#sync-state');if(sync)sync.textContent='연결 확인 중 · 잠시 후 다시 동기화합니다.';}
    finally {v.polling=false;if(bookingView===v)poll=setTimeout(refresh,pollDelay(failures,retryAfter));}
  };
  poll=setTimeout(refresh,pollDelay());
}
function renderBooking() {
  const v=bookingView;if(!v)return;const p=v.map.performance;
  app.innerHTML=`<div class="container booking-page"><a class="back-link" href="#/concert/${p.concert_id}">${icon('back')}공연 상세</a><div class="booking-header"><div><span class="eyebrow">YOUR SEAT IS WAITING</span><h1>${escape(p.title)}</h1><p>${date(p.starts_at)} <span>·</span> ${escape(p.venue)}</p></div><div class="timer">${icon('clock')}<b id="hold-timer"></b></div></div><ol class="steps"><li class="${v.stage==='seats'?'current':'done'}"><span>${v.stage==='seats'?'1':icon('check',14)}</span>좌석 선택</li><li class="${v.stage==='checkout'?'current':''}"><span>2</span>주문 확인 · 데모 결제</li><li><span>3</span>예매 완료</li></ol><div id="booking-content"></div></div>`;
  $('#booking-content').insertAdjacentHTML('beforebegin',`<p id="admission-note" class="caption" role="status">${v.queue?.mode==='hold-recovery'?'입장 시간이 끝났습니다. 현재 선점의 확정 또는 선택 초기화만 가능합니다.':'입장 완료 · 좌석 선택 시간이 끝나도 유효한 선점은 확정할 수 있습니다.'}</p>`);
  if(v.stage==='seats') {
    $('#booking-content').innerHTML=`<div class="booking-layout"><section class="panel map-panel"><div class="section-head compact"><h2>원하는 좌석을 선택하세요</h2><button class="text-button" id="clear-seats">선택 초기화</button></div>${seatLegend}<div id="map"></div><div class="map-note">${icon('lock',16)}<span id="sync-state">좌석 현황 동기화 중 · 3초 간격</span><span class="map-limit">1인 최대 4매</span></div></section><aside class="panel selection-panel"><div class="section-head compact"><h2>선택한 좌석</h2><span id="seat-count" class="pill neutral">0 / 4</span></div><div id="selected-list"></div><dl class="amounts"><div><dt>티켓 금액</dt><dd id="ticket-price"></dd></div><div><dt>예매 수수료</dt><dd id="fee-price"></dd></div><div class="total"><dt>총 결제 금액</dt><dd id="total-price"></dd></div></dl><button class="button full" id="next-step">다음 단계 ${icon('arrow')}</button><p class="caption">선택 시점부터 7분간 선점됩니다.<br>좌석 추가 시 제한 시간이 연장되지 않습니다.</p></aside></div>`;
    $('#next-step').addEventListener('click',()=>{if(!selectedSeats().length||v.busy)return;v.stage='checkout';renderBooking();});
    $('#clear-seats').addEventListener('click',async()=>{if(v.busy)return;v.busy=true;v.mutation++;updateSeatPanel();try{await api(`/api/performances/${v.id}/hold`,{method:'PUT',body:{seatIds:[]}});v.map=await api(`/api/performances/${v.id}/seats`);}catch(e){toast(e.message);}finally{v.busy=false;if(bookingView===v)updateSeatPanel();}});
    updateSeatPanel();
  } else {
    const checkoutHoldId=v.map.hold?.id;
    const seats=selectedSeats(),ticketTotal=seats.reduce((n,s)=>n+s.price,0),fee=seats.length*2000;
    $('#booking-content').innerHTML=`<form id="checkout-form" class="booking-layout"><section class="panel checkout-panel"><div class="section-head compact"><h2>예매자 정보</h2><button type="button" class="text-button" id="edit-seats">좌석 다시 선택</button></div><div class="form-error" role="alert" hidden></div><div class="form-row"><label>예매자 이름<input name="buyerName" required minlength="2" maxlength="40" autocomplete="name" value="${escape(session.user.name)}"></label><label>휴대폰 번호<input name="buyerPhone" type="tel" required autocomplete="tel" pattern="01[016789][- ]?[0-9]{3,4}[- ]?[0-9]{4}" value="${escape(session.user.phone)}"></label></div><h3>티켓 수령 방법</h3><div class="delivery-options"><label class="radio-card"><input type="radio" name="delivery" value="mobile" checked><span><b>모바일 티켓</b><small>나의 티켓에서 확인</small></span></label><label class="radio-card"><input type="radio" name="delivery" value="onsite"><span><b>현장 수령</b><small>예매번호로 확인</small></span></label></div><h3>결제 방법</h3><div class="demo-payment"><span class="pill">DEMO</span><div><b>데모 결제</b><p>금액이 청구되지 않으며 카드 정보를 입력하지 않습니다.</p></div></div><label class="check-label checkout-agree"><input type="checkbox" name="agreed" required><span>공연·좌석·수령 방법과 <b>데모 취소 규정</b>을 확인했습니다.<small>공연 시작 전까지 전액 취소 가능 · 실제 티켓은 발권되지 않습니다.</small></span></label></section><aside class="panel selection-panel"><h2>예매 정보</h2><p class="muted">${escape(p.title)}</p><div class="checkout-seats">${seats.map(s=>`<span class="pill neutral">${s.grade} ${s.id}</span>`).join('')}</div><dl class="amounts"><div><dt>티켓 ${seats.length}매</dt><dd>${won(ticketTotal)}</dd></div><div><dt>예매 수수료</dt><dd>${won(fee)}</dd></div><div class="total"><dt>총 결제 금액</dt><dd>${won(ticketTotal+fee)}</dd></div></dl><button class="button full" type="submit">${won(ticketTotal+fee)} 데모 결제 ${icon('arrow')}</button><p class="caption center">실제 결제 없이 예매가 완료됩니다.</p></aside></form>`;
    $('#edit-seats').addEventListener('click',()=>{if(v.busy)return;v.stage='seats';renderBooking();});
    $('#checkout-form').addEventListener('submit',async e=>{
      e.preventDefault();if(v.busy)return;const form=e.currentTarget,data=Object.fromEntries(new FormData(form));const error=$('.form-error',form);error.hidden=true;
      if(!checkoutHoldId){toast('좌석 선점 시간을 확인해 주세요.');return;}
      v.busy=true;$('button[type=submit]',form).disabled=true;
      try {const {booking}=await api('/api/bookings',{method:'POST',headers:{'X-Admission-Token':v.queue.admission_token},body:{...data,agreed:data.agreed==='on',holdId:checkoutHoldId,paymentMethod:'demo'}});clearInterval(poll);clearInterval(tick);location.hash=`#/complete/${booking.id}`;}
      catch(e){error.textContent=e.message;error.hidden=false;$('button[type=submit]',form).disabled=false;}
      finally {v.busy=false;}
    });
    updateTimer();
  }
}

async function confirmCancel(b) {
  const dialog=$('#confirm-dialog');$('#dialog-body').textContent=`${b.title} · ${b.seats.length}매를 취소합니다. 데모 결제 ${won(b.total)}이 전액 취소되고 좌석이 다시 판매됩니다.`;
  const yes=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'),{once:true});dialog.showModal();});
  if(!yes)return;
  try {await api(`/api/bookings/${b.id}/cancel`,{method:'POST'});toast('예매가 취소되었어요.');if(location.hash.startsWith('#/complete/'))location.hash='#/bookings';else await myBookings();}catch(e){toast(e.message);}
}
async function myBookings(completeId) {
  if(!requireAuth())return;const r=revision,{bookings}=await api('/api/bookings');if(r!==revision)return;
  const complete=completeId?bookings.find(b=>b.id===completeId):null;
  if(completeId&&!complete)throw new Error('예매 내역을 찾을 수 없습니다.');
  app.innerHTML=`<div class="container my-page">${complete?.status==='confirmed'?`<section class="success-banner"><span class="success-check">${icon('check',30)}</span><div><span class="eyebrow">SEE YOU AT THE SHOW</span><h1>예매가 완료되었어요!</h1><p>당신의 특별한 순간을 기다릴게요. 실제 결제가 없는 데모 예매입니다.</p></div></section>`:title('MY TICKETS','나의 티켓','기다려지는 순간들을 한곳에서 관리하세요.')}<div class="ticket-tabs filter-tabs" role="group" aria-label="예매 상태 필터"><button class="filter-tab active" data-status="all" aria-pressed="true">전체 ${bookings.length}</button><button class="filter-tab" data-status="confirmed" aria-pressed="false">예매 완료 ${bookings.filter(b=>b.status==='confirmed').length}</button><button class="filter-tab" data-status="cancelled" aria-pressed="false">취소 ${bookings.filter(b=>b.status==='cancelled').length}</button></div><div id="booking-list"></div></div>`;
  function render(status='all') {
    const list=bookings.filter(b=>status==='all'||b.status===status);
    $('#booking-list').innerHTML=list.length?list.map(b=>`<article class="ticket-card ${b.status==='cancelled'?'cancelled':''}" id="${b.id}"><div class="ticket-thumb">${poster({...b,title:b.title,artist:b.artist})}</div><div class="ticket-info"><div class="ticket-top"><span class="pill ${b.status==='confirmed'?'':'neutral'}">${b.status==='confirmed'?'예매 완료':'취소 완료'}</span><span class="caption">예매번호 ${b.id}</span></div><h2>${escape(b.title)}</h2><p>${date(b.starts_at)}</p><p>${escape(b.venue)}</p><div class="checkout-seats">${b.seats.map(s=>`<span class="pill neutral">${s.grade} ${s.seat_id}</span>`).join('')}</div><details class="ticket-details"><summary>예매 상세 확인</summary><dl class="info-list"><div><dt>예매자</dt><dd>${escape(b.buyer_name)} · ${escape(b.buyer_phone)}</dd></div><div><dt>수령 방법</dt><dd>${b.delivery==='mobile'?'모바일 티켓 (데모)':'현장 수령 (데모)'}</dd></div><div><dt>예매 일시</dt><dd>${date(b.created_at)}</dd></div><div><dt>티켓 / 수수료</dt><dd>${won(b.ticket_total)} / ${won(b.fee)}</dd></div>${b.cancelled_at?`<div><dt>취소 일시</dt><dd>${date(b.cancelled_at)}</dd></div>`:''}</dl></details></div><div class="ticket-actions"><span class="muted">${b.seats.length}매 · 데모 결제</span><strong>${won(b.total)}</strong>${b.status==='confirmed'&&b.starts_at>Date.now()?`<button class="button secondary" data-cancel="${b.id}">예매 취소</button>`:`<span class="caption">${b.status==='cancelled'?'전액 취소됨':'취소 마감'}</span>`}<span class="caption">실제 입장용 티켓이 아닙니다.</span></div></article>`).join(''):empty('아직 예매한 티켓이 없어요.');
    $$('[data-cancel]').forEach(button=>button.addEventListener('click',()=>confirmCancel(bookings.find(b=>b.id===button.dataset.cancel))));
  }
  $$('.ticket-tabs button').forEach(b=>b.addEventListener('click',()=>{$$('.ticket-tabs button').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',x===b);});render(b.dataset.status);}));render();
}

function accountPage() {
  if(!requireAuth())return;
  if(session.user.role==='admin')throw new Error('관리자 계정은 회원 탈퇴할 수 없습니다.');
  app.innerHTML=`<div class="container account-page">${title('MY ACCOUNT','계정 관리','회원 탈퇴 전 아래 내용을 확인해 주세요.')}<section class="panel"><h2>회원 탈퇴</h2><p>${escape(session.user.email)}</p><p>공연 시작 전 확정 예매가 있다면 <a class="admin-link" href="#/bookings">나의 티켓</a>에서 먼저 취소해 주세요. 탈퇴하면 모든 기기에서 로그아웃되고 대기열과 선점 좌석이 해제됩니다.</p><p>회원 정보와 예매자 이름·전화번호는 비식별 값으로 바뀝니다. 예매·결제 이력의 금액과 좌석 정보는 보존되며, 같은 이메일로 다시 가입해도 이전 내역은 복구되지 않습니다.</p><form id="withdraw-form"><div class="form-error" role="alert" hidden></div><label>현재 비밀번호<input name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required></label><label class="check-label"><input name="confirmed" type="checkbox" required><span>탈퇴 안내를 확인했으며 계정 복구가 불가능함에 동의합니다.</span></label><button class="button danger" type="submit">회원 탈퇴</button></form></section></div>`;
  $('#withdraw-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.currentTarget,button=$('button[type=submit]',form),error=$('.form-error',form);
    button.disabled=true;error.hidden=true;
    try {
      await api('/api/auth/account',{method:'DELETE',body:{password:form.elements.password.value,confirmed:form.elements.confirmed.checked}});
      form.reset();session={...session,user:null,csrf:null};returnTo='#/';account();location.hash='#/';toast('회원 탈퇴가 완료되었어요.');
    } catch(e) {error.textContent=e.message;error.hidden=false;button.disabled=false;}
  });
}

function auditMarkup(items) {
  return items.length ? items.map(a=>`<div><span class="audit-icon">${icon(a.action==='create-concert'?'plus':'lock',17)}</span><div><b>${a.action==='block'?'좌석 차단':a.action==='unblock'?'차단 해제':'공연 등록'}</b><p>${escape(a.name)} · ${date(a.created_at)}</p><small>${escape(a.detail)}</small></div></div>`).join('') : '<p class="muted">아직 운영 기록이 없습니다.</p>';
}
async function adminPage() {
  if(!requireAuth())return;
  if(session.user.role!=='admin')throw new Error('관리자 권한이 필요합니다.');
  const r=revision,data=await api('/api/admin/summary');if(r!==revision)return;
  app.innerHTML=`<div class="container admin-page">${title('ticket-ssu OPERATIONS','공연 · 좌석 관리','회차별 판매 현황을 확인하고 운영 좌석을 관리하세요.')}<div class="stats"><div><span>예매 완료</span><strong>${data.stats.bookings}<small>건</small></strong></div><div><span>데모 결제 총액</span><strong>${won(data.stats.revenue)}</strong></div><div><span>회원 수</span><strong>${data.users}<small>명</small></strong></div><div><span>공연 회차</span><strong>${data.performances.length}<small>회</small></strong></div></div><section class="panel admin-seats"><div class="section-head compact"><h2>좌석 판매 관리</h2><span class="pill neutral">운영자 전용</span></div><label class="select-performance">관리할 회차<select id="admin-performance">${data.performances.map(p=>`<option value="${p.id}">${escape(p.title)} · ${date(p.starts_at)}</option>`).join('')}</select></label><div id="admin-seat-content">${loading()}</div></section><div class="admin-bottom"><section class="panel"><div class="section-head compact"><h2>새 공연 등록</h2>${icon('plus')}</div><p class="caption">회차당 96석 · VIP 24석 / R 36석 / S 36석이 생성됩니다.</p><form id="create-concert"><div class="form-error" role="alert" hidden></div><label>공연명<input name="title" maxlength="120" required placeholder="공연 제목"></label><div class="form-row"><label>아티스트<input name="artist" maxlength="120" required></label><label>공연장<input name="venue" maxlength="120" required></label></div><label>공연 소개<textarea name="description" maxlength="2000" required rows="3"></textarea></label><label>공연 일시 (한국 시간)<input type="datetime-local" name="date" required></label><label>추가 회차 (선택 · 한국 시간)<input type="datetime-local" name="date2"></label><label>예매 오픈 일시 (선택 · 한국 시간)<input type="datetime-local" name="bookingOpensAt"></label><p class="caption">비워 두면 등록 즉시 예매가 열립니다. 첫 회차 시작 전이어야 합니다.</p><label>S석 기본 가격 (원)<input type="number" name="basePrice" min="1000" max="1000000" step="1000" value="90000" required></label><p class="caption">R석: 기본가 + 20,000원 / VIP석: 기본가 + 40,000원<br>관람 시간 120분 · 8세 이상 · 회차당 1인 4매</p><button class="button full" type="submit">공연 등록 ${icon('plus')}</button></form></section><section class="panel"><h2>최근 운영 기록</h2><div class="audit-list">${auditMarkup(data.audit)}</div></section></div></div>`;
  let adminMap,selection=new Set(),busy=false,loadGeneration=0;
  async function loadSeats(){
    const g=++loadGeneration,pid=$('#admin-performance').value;
    adminMap=null;selection.clear();$('#admin-seat-content').innerHTML=loading();
    try {
      const map=await api(`/api/performances/${pid}/seats`);
      if(r!==revision||g!==loadGeneration)return;
      adminMap=map;renderAdminMap();
      const latest=await api('/api/admin/summary');
      if(r===revision&&g===loadGeneration)$('.audit-list').innerHTML=auditMarkup(latest.audit);
    } catch(e) {
      if(r===revision&&g===loadGeneration)$('#admin-seat-content').textContent=e.message;
      throw e;
    }
  }
  function renderAdminMap(){
    if(!adminMap||r!==revision)return;
    const counts={available:0,held:0,selected:0,booked:0,blocked:0};adminMap.seats.forEach(s=>counts[s.state]++);
    $('#admin-seat-content').innerHTML=`<div class="inventory-summary"><span>판매 가능 <b>${counts.available}</b></span><span>선점 중 <b>${counts.held+counts.selected}</b></span><span>예매 완료 <b>${counts.booked}</b></span><span>차단 <b>${counts.blocked}</b></span></div>${seatLegend}${seatGrid(adminMap,true,selection)}<div class="admin-seat-tools"><span><b>${selection.size}</b>석 선택</span><button class="button secondary small" id="admin-refresh">현황 새로고침</button><button class="button secondary small" id="unblock">차단 해제</button><button class="button small" id="block">판매 차단</button></div><p class="caption">판매 가능한 좌석과 차단 좌석을 클릭해 선택하세요. 선점·예매된 좌석은 변경할 수 없습니다.</p>`;
    $$('[data-seat]').forEach(b=>b.addEventListener('click',()=>{if(busy)return;selection.has(b.dataset.seat)?selection.delete(b.dataset.seat):selection.add(b.dataset.seat);renderAdminMap();}));
    $('#admin-refresh').addEventListener('click',()=>loadSeats().catch(e=>toast(e.message)));
    for(const [selector,blocked] of [['#block',true],['#unblock',false]]){
      const b=$(selector);b.disabled=!selection.size||busy;
      b.addEventListener('click',async()=>{
        const performanceSelect=$('#admin-performance');
        if(busy||!adminMap||!selection.size||performanceSelect.value!==adminMap.performance.id)return;
        const pid=adminMap.performance.id,ids=[...selection];
        busy=true;performanceSelect.disabled=true;renderAdminMap();
        try {
          await api(`/api/admin/performances/${pid}/seats`,{method:'PATCH',body:{seatIds:ids,blocked}});
          if(r===revision)toast(`${ids.length}석 ${blocked?'판매 차단':'차단 해제'} 완료`);
        }catch(e){toast(e.message);}
        finally {
          busy=false;performanceSelect.disabled=false;
          if(r===revision)try{await loadSeats();}catch(e){toast(e.message);}
        }
      });
    }
  }
  $('#admin-performance').addEventListener('change',()=>loadSeats().catch(e=>toast(e.message)));await loadSeats();
  $('#create-concert').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,data=Object.fromEntries(new FormData(form));const error=$('.form-error',form);error.hidden=true;const button=$('button[type=submit]',form);button.disabled=true;
    try {await api('/api/admin/concerts',{method:'POST',body:{...data,basePrice:Number(data.basePrice),dates:[data.date,data.date2].filter(Boolean).map(s=>s+':00+09:00'),bookingOpensAt:data.bookingOpensAt?data.bookingOpensAt+':00+09:00':undefined}});concerts=[];toast('공연과 좌석이 등록되었어요.');await adminPage();}catch(e){error.textContent=e.message;error.hidden=false;button.disabled=false;}
  });
}

async function route() {
  revision++;const r=revision;clearInterval(poll);clearInterval(tick);queueController?.abort();queueController=null;bookingView=null;window.scrollTo(0,0);
  const parts=(location.hash.slice(1)||'/').split('/').filter(Boolean),page=parts[0]||'home';
  $$('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===(['bookings','complete'].includes(page)?'bookings':'home')));
  app.innerHTML=loading();
  try {
    if(page==='home')await home();else if(page==='login'||page==='signup')authPage(page==='signup');else if(page==='concert')await concertDetail(parts[1]);else if(page==='book')await bookingPage(parts[1]);else if(page==='bookings'||page==='complete')await myBookings(page==='complete'?parts[1]:undefined);else if(page==='account')accountPage();else if(page==='admin')await adminPage();else throw new Error('페이지를 찾을 수 없습니다.');
    if(r===revision)app.focus({preventScroll:true});
  }catch(e){if(r!==revision)return;app.innerHTML=`<div class="container">${empty(escape(e.message),'홈으로 돌아가기')}<button class="button secondary retry" id="retry">다시 시도</button></div>`;$('#retry').addEventListener('click',route);}
}
window.addEventListener('hashchange',route);
try {session=await api('/api/session');account();await route();}catch(e){app.innerHTML=`<div class="empty"><h2>서버에 연결할 수 없어요.</h2><p>${escape(e.message)}</p><a href="/" class="button">새로고침</a></div>`;}
