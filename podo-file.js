/* ══════════════════════════════════════════════════════════════════
   📁 podo-file.js — 포도야 파일 산출물 모듈 (XLSX · PPTX)
   ------------------------------------------------------------------
   · 라이브러리는 "누를 때" 받아온다 (첫 로딩 무게 0)
   · 저장은 모바일이면 공유시트(카톡·메일·파일앱), PC면 다운로드
   · index.html 은 건드리지 않는다. 아래 3줄만 붙이면 끝.
   ══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

var CDN_XLSX = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
var CDN_PPTX = 'https://cdn.jsdelivr.net/gh/gitbrent/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';

/* ── 공통: 스크립트 1회 로딩 (중복 클릭해도 1번만 받음) ───────────── */
var _pending = {};
function loadLib(src, globalName, ok, fail){
  if(window[globalName]){ ok(); return; }
  if(_pending[src]){ _pending[src].push([ok, fail]); return; }
  _pending[src] = [[ok, fail]];
  var s = document.createElement('script');
  s.src = src; s.async = true;
  s.onload = function(){
    var qs = _pending[src] || []; delete _pending[src];
    var e = window[globalName] ? null : new Error('라이브러리를 읽지 못했어요');
    qs.forEach(function(q){ e ? (q[1] && q[1](e)) : q[0](); });
  };
  s.onerror = function(){
    var qs = _pending[src] || []; delete _pending[src];
    var e = new Error('인터넷에서 파일 만들기 도구를 못 받았어요. 연결을 확인해 주세요.');
    qs.forEach(function(q){ q[1] && q[1](e); });
  };
  document.head.appendChild(s);
}

/* ── 공통: 토스트 (기존 함수 재사용, 없으면 무시) ─────────────────── */
function say(msg, bg){
  try{ if(typeof showToast==='function'){ showToast(msg, bg||'linear-gradient(135deg,#22c55e,#15803d)'); return; } }catch(e){}
  try{ if(typeof toast==='function'){ toast(msg); return; } }catch(e){}
}
function oops(e){
  var m = (e && e.message) || '파일을 만들지 못했어요';
  say('⚠️ ' + m, 'linear-gradient(135deg,#ef4444,#b91c1c)');
}

/* ── 공통: 저장 ────────────────────────────────────────────────────
   모바일 = 공유시트로 (카톡·메일·파일앱으로 바로 넘어감)
   PC     = 그냥 다운로드
   카톡 인앱 브라우저는 다운로드가 막히는 경우가 있어 공유를 먼저 시도한다. */
var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
function saveFile(blob, name){
  if(isMobile){
    try{
      var f = new File([blob], name, { type: blob.type });
      if(navigator.share && navigator.canShare && navigator.canShare({ files:[f] })){
        navigator.share({ files:[f], title:name })
          .then(function(){ say('📁 ' + name); })
          .catch(function(){ download(blob, name); });
        return;
      }
    }catch(e){}
  }
  download(blob, name);
}
function download(blob, name){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ try{ document.body.removeChild(a); }catch(e){} URL.revokeObjectURL(url); }, 2000);
  say('📁 ' + name + ' 저장됨');
}

function stamp(){
  var d = new Date(), p = function(n){ return (n<10?'0':'') + n; };
  return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate());
}
function num(n){ return Number(n) || 0; }

/* ══════════════════════════════════════════════════════════════════
   1. XLSX — 범용 만들기
   sheets: [{ name:'내역', rows:[[...],[...]], widths:[12,20], money:[4] }]
   money  = 천단위 쉼표를 넣을 열 번호(0부터)
   ══════════════════════════════════════════════════════════════════ */
function podoXlsx(sheets, filename, done){
  loadLib(CDN_XLSX, 'XLSX', function(){
    try{
      var wb = XLSX.utils.book_new();
      sheets.forEach(function(sh){
        var ws = XLSX.utils.aoa_to_sheet(sh.rows || [[]]);
        if(sh.widths) ws['!cols'] = sh.widths.map(function(w){ return { wch:w }; });
        (sh.money || []).forEach(function(col){
          for(var r = 1; r < (sh.rows||[]).length; r++){
            var ref = XLSX.utils.encode_cell({ r:r, c:col });
            if(ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0';
          }
        });
        XLSX.utils.book_append_sheet(wb, ws, (sh.name || 'Sheet').slice(0, 31));
      });
      var buf = XLSX.write(wb, { bookType:'xlsx', type:'array' });
      var blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveFile(blob, filename);
      done && done();
    }catch(e){ oops(e); done && done(e); }
  }, function(e){ oops(e); done && done(e); });
}

/* ── 1-A. 가계부 → 엑셀 (내역 · 월별정산 · 분류별정산 3시트) ──────── */
function ledgerXlsx(){
  var arr = [];
  try{ arr = (typeof getLedger === 'function') ? getLedger() : []; }catch(e){}
  if(!arr.length){ say('⚠️ 내보낼 기록이 없어요', 'linear-gradient(135deg,#f59e0b,#d97706)'); return; }

  var rows = arr.slice().sort(function(a,b){ return (a.date||'') < (b.date||'') ? 1 : -1; });

  /* 시트 1 — 내역 */
  var s1 = [['날짜','구분','분류','메모','금액','공제 가능성','메모(공제)']];
  rows.forEach(function(e){
    s1.push([ e.date||'', e.biz ? '사업' : '개인', e.cat||'', e.memo||'',
              num(e.amount), e.ded||'', e.dedWhy||'' ]);
  });
  s1.push([]);
  s1.push(['합계','','','', rows.reduce(function(a,e){ return a + num(e.amount); }, 0), '', '']);

  /* 시트 2 — 월별 정산 */
  var byM = {};
  rows.forEach(function(e){
    var m = (e.date || '').slice(0,7) || '미상';
    if(!byM[m]) byM[m] = { cnt:0, sum:0, biz:0 };
    byM[m].cnt++; byM[m].sum += num(e.amount);
    if(e.biz) byM[m].biz += num(e.amount);
  });
  var s2 = [['월','건수','합계','사업 경비분','개인분']];
  Object.keys(byM).sort().reverse().forEach(function(m){
    var v = byM[m];
    s2.push([m, v.cnt, v.sum, v.biz, v.sum - v.biz]);
  });

  /* 시트 3 — 분류별 정산 */
  var byC = {}, total = 0;
  rows.forEach(function(e){
    var c = e.cat || '기타';
    byC[c] = (byC[c] || 0) + num(e.amount);
    total += num(e.amount);
  });
  var s3 = [['분류','합계','비중']];
  Object.keys(byC).sort(function(a,b){ return byC[b] - byC[a]; }).forEach(function(c){
    s3.push([c, byC[c], total ? Math.round(byC[c]/total*1000)/10 + '%' : '0%']);
  });

  podoXlsx([
    { name:'내역',      rows:s1, widths:[12,7,12,26,13,12,20], money:[4] },
    { name:'월별 정산', rows:s2, widths:[10,7,14,14,14],       money:[2,3,4] },
    { name:'분류별 정산', rows:s3, widths:[14,14,9],           money:[1] }
  ], '포도야_가계부_' + stamp() + '.xlsx');
}

/* ── 1-B. 문서(견적서·명세서) → 엑셀 ─────────────────────────────── */
function docXlsx(){
  var d = window._docData;
  if(!d || !d.items || !d.items.length){ say('⚠️ 먼저 문서를 만들어 주세요', 'linear-gradient(135deg,#f59e0b,#d97706)'); return; }
  var me = {}; try{ me = (typeof docMe === 'function') ? docMe() : {}; }catch(e){}
  var EN = (d.kind === 'inv'), sum = 0;

  var rows = [
    [EN ? 'INVOICE' : d.kn],
    [EN ? 'Bill to' : '받는 곳', d.to || ''],
    [EN ? 'From'    : '공급자',  me.biz || ''],
    [EN ? 'Date'    : '작성일',  (typeof _dToday === 'function') ? _dToday() : ''],
    [],
    [EN ? 'No' : '번호', EN ? 'Description' : '품명', EN ? 'Qty' : '수량',
     EN ? 'Unit' : '단위', EN ? 'Unit Price' : '단가', EN ? 'Amount' : '금액']
  ];
  d.items.forEach(function(it, i){
    var q = num(it.qty) || 1, p = num(it.price), amt = q * p; sum += amt;
    rows.push([i+1, it.name || '', q, it.unit || '', p, amt]);
  });
  rows.push([]);
  rows.push(['', '', '', '', EN ? 'Subtotal' : '공급가액', sum]);
  if(!EN){
    var vat = Math.round(sum * 0.1);
    rows.push(['', '', '', '', '부가세 (10%)', vat]);
    rows.push(['', '', '', '', '합계', sum + vat]);
  } else {
    rows.push(['', '', '', '', 'TOTAL (' + (d.cur || 'USD') + ')', sum]);
  }
  if(d.note) rows.push([], [EN ? 'Notes' : '비고', d.note]);

  podoXlsx([{ name: EN ? 'Invoice' : d.kn, rows:rows, widths:[6,28,7,7,13,14], money:[4,5] }],
    (EN ? 'INVOICE_' : '포도야_' + d.kn + '_') + stamp() + '.xlsx');
}

/* ══════════════════════════════════════════════════════════════════
   2. PPTX — 범용 만들기
   deck = { title, sub, slides:[{ t:'제목', b:['불릿','불릿'] }] }
   ══════════════════════════════════════════════════════════════════ */
var PPT_FONT = 'Malgun Gothic';   /* 윈도우·맥 모두 한글이 깨지지 않는 조합 */
var PPT_INK  = '1F2430';
var PPT_KEY  = '7C3AED';

function podoPptx(deck, filename, done){
  loadLib(CDN_PPTX, 'PptxGenJS', function(){
    try{
      var pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_16x9';
      pptx.author = '포도야';
      pptx.title  = deck.title || '발표자료';

      /* 표지 */
      var cover = pptx.addSlide();
      cover.background = { color:'FFFFFF' };
      cover.addShape(pptx.ShapeType.rect, { x:0, y:0, w:0.22, h:5.63, fill:{ color:PPT_KEY } });
      cover.addText(deck.title || '발표자료', {
        x:0.9, y:2.0, w:8.4, h:1.1, fontSize:38, bold:true, color:PPT_INK, fontFace:PPT_FONT
      });
      if(deck.sub) cover.addText(deck.sub, {
        x:0.9, y:3.1, w:8.4, h:0.7, fontSize:17, color:'6B7280', fontFace:PPT_FONT
      });
      cover.addText(new Date().toLocaleDateString('ko-KR'), {
        x:0.9, y:4.7, w:4, h:0.4, fontSize:12, color:'9CA3AF', fontFace:PPT_FONT
      });

      /* 본문 */
      (deck.slides || []).forEach(function(s, i){
        var sl = pptx.addSlide();
        sl.background = { color:'FFFFFF' };
        sl.addText(s.t || ('슬라이드 ' + (i+1)), {
          x:0.7, y:0.5, w:8.6, h:0.8, fontSize:26, bold:true, color:PPT_INK, fontFace:PPT_FONT
        });
        sl.addShape(pptx.ShapeType.rect, { x:0.7, y:1.32, w:1.1, h:0.05, fill:{ color:PPT_KEY } });
        var bullets = (s.b || []).map(function(t){
          return { text:String(t), options:{ bullet:{ code:'2022' }, breakLine:true } };
        });
        if(bullets.length) sl.addText(bullets, {
          x:0.8, y:1.7, w:8.4, h:3.3, fontSize:16, color:'374151',
          fontFace:PPT_FONT, lineSpacingMultiple:1.35, valign:'top'
        });
        sl.addText(String(i+1), {
          x:9.0, y:5.05, w:0.5, h:0.3, fontSize:10, color:'C4C7D0', align:'right', fontFace:PPT_FONT
        });
      });

      var p = pptx.write({ outputType:'blob' });
      if(!p || !p.then) p = pptx.write('blob');
      p.then(function(blob){
        if(!(blob instanceof Blob)) blob = new Blob([blob], { type:'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
        saveFile(blob, filename);
        done && done();
      }).catch(function(e){ oops(e); done && done(e); });
    }catch(e){ oops(e); done && done(e); }
  }, function(e){ oops(e); done && done(e); });
}

/* ── 2-A. 말 → 발표자료 화면 ─────────────────────────────────────── */
function openPptMaker(){
  if(typeof _pmScreen !== 'function'){ say('⚠️ 화면을 열 수 없어요'); return; }
  var bg = _pmScreen('ppt-bg', '발표자료 만들기', closePptMaker);
  var w = document.createElement('div');
  w.style.cssText = 'padding:14px 14px 40px';
  w.innerHTML =
    '<div style="background:#f8f5ff;border:1px solid #e5dcfb;border-radius:13px;padding:12px 13px;margin-bottom:14px">'+
      '<div style="font-size:12.5px;font-weight:800;color:#6d28d9">📊 말하면 PPT가 나와요</div>'+
      '<div style="font-size:11.5px;color:#7c6aa8;margin-top:5px;line-height:1.55">주제를 적으면 AI가 목차를 잡고 <b>파워포인트 파일(.pptx)</b>로 만들어줘요. 받아서 바로 고쳐 쓰면 돼요.</div>'+
    '</div>'+
    '<div style="font-size:12px;font-weight:800;color:#555;margin-bottom:5px">무엇에 대한 자료인가요</div>'+
    '<textarea id="ppt-q" placeholder="예: 우리 반찬가게 프랜차이즈 사업 제안서. 매장 3개, 월매출 4천, 배달 비중 60%" '+
      'style="width:100%;box-sizing:border-box;background:#f7f7f8;border:1px solid #e6e6e6;border-radius:11px;padding:11px 12px;font-size:14px;color:#111;outline:none;font-family:inherit;resize:none;min-height:80px;line-height:1.6"></textarea>'+
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">'+
      ['사업 제안서','상품 소개서','투자 유치','교육 자료'].map(function(t){
        return '<button onclick="pptPreset(\''+t+'\')" style="flex:1;min-width:80px;padding:8px 6px;border-radius:9px;border:1.5px solid #e6e6e6;background:#fff;color:#666;font-weight:800;font-size:11.5px;cursor:pointer;font-family:inherit">'+t+'</button>';
      }).join('')+
    '</div>'+
    '<button onclick="pptMake()" style="width:100%;margin-top:11px;padding:13px;border-radius:12px;border:none;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:800;font-size:14.5px;cursor:pointer;font-family:inherit">✨ 목차 만들기</button>'+
    '<div id="ppt-out" style="margin-top:14px"></div>';
  bg.appendChild(w);
  bg.style.display = 'flex';
  try{ history.pushState({ p:true }, '', ''); }catch(e){}
}
function closePptMaker(){ if(typeof _pmClose === 'function') _pmClose('ppt-bg'); }
function pptPreset(t){
  var q = document.getElementById('ppt-q'); if(!q) return;
  q.value = (q.value ? q.value.replace(/\s*\((사업 제안서|상품 소개서|투자 유치|교육 자료)\)$/, '') : '') + ' (' + t + ')';
  q.focus();
}

function pptMake(){
  var q = ((document.getElementById('ppt-q') || {}).value || '').trim();
  var out = document.getElementById('ppt-out');
  if(!q){ if(out) out.innerHTML = '<div style="font-size:12.5px;color:#9a3412">무엇을 만들지 적어주세요</div>'; return; }
  if(out) out.innerHTML = '<div style="font-size:12.5px;color:#6d28d9">⏳ 목차를 잡는 중…</div>';

  var sys = '너는 한국 소상공인용 발표자료 작성기야. 아래 내용으로 슬라이드 구성을 만들어 JSON만 출력해(설명·코드펜스 금지).\n'+
    '{"title":"표지 제목(15자 내외)","sub":"부제 한 줄","slides":[{"t":"슬라이드 제목","b":["불릿 한 줄","불릿 한 줄"]}]}\n'+
    '규칙: 슬라이드 5~7장. 불릿은 장당 3~4개, 한 줄에 35자 이내. 숫자가 주어지면 그대로 쓰고, 없는 숫자는 지어내지 마라.';

  var onText = function(txt){
    var d = null;
    try{ d = JSON.parse(String(txt || '').replace(/```json|```/g, '').trim()); }catch(e){}
    if(!d || !d.slides || !d.slides.length){
      if(out) out.innerHTML = '<div style="font-size:12.5px;color:#b91c1c">⚠️ 목차를 못 읽었어요. 조금 더 자세히 적어 주세요.</div>';
      return;
    }
    window._pptDeck = d;
    pptRender();
  };
  var onErr = function(e){
    if(!out) return;
    var m = (e && e.message) || '실패';
    out.innerHTML = '<div style="font-size:12.5px;color:#b91c1c">⚠️ ' + (m === 'NO_KEY' ? 'AI 연결이 필요해요' : m) + '</div>' +
      ((m === 'NO_KEY' && typeof _noKeyBtn === 'function') ? _noKeyBtn() : '');
  };

  /* 기존 AI 호출부를 그대로 쓴다 (_agentAiP 가 있으면 우선) */
  if(typeof _agentAiP === 'function'){
    _agentAiP(sys, q, 1200).then(onText).catch(onErr);
  } else if(typeof callAI === 'function'){
    callAI({ system:sys, messages:[{ role:'user', content:q }], maxTokens:1200 }, onText, onErr);
  } else {
    onErr(new Error('AI 연결이 필요해요'));
  }
}

function pptRender(){
  var d = window._pptDeck, out = document.getElementById('ppt-out');
  if(!d || !out) return;
  var esc = (typeof _agentEsc === 'function') ? _agentEsc : function(s){ return String(s || '').replace(/[<>&]/g, ''); };
  var body = (d.slides || []).map(function(s, i){
    return '<div style="border-bottom:1px solid #f0f0f0;padding:10px 2px">'+
      '<div style="font-size:13px;font-weight:800;color:#111">'+(i+1)+'. '+esc(s.t || '')+'</div>'+
      '<div style="font-size:12px;color:#777;margin-top:4px;line-height:1.6">'+(s.b || []).map(function(b){ return '· ' + esc(b); }).join('<br>')+'</div>'+
    '</div>';
  }).join('');
  out.innerHTML =
    '<div style="border:1px solid #e6e6e6;border-radius:12px;background:#fff;padding:12px 13px">'+
      '<div style="font-size:16px;font-weight:900;color:#111">'+esc(d.title || '발표자료')+'</div>'+
      (d.sub ? '<div style="font-size:12px;color:#888;margin-top:3px">'+esc(d.sub)+'</div>' : '')+
      '<div style="margin-top:8px">'+body+'</div>'+
    '</div>'+
    '<button id="ppt-dl" onclick="pptSave()" style="width:100%;margin-top:10px;padding:13px;border-radius:12px;border:none;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:800;font-size:14.5px;cursor:pointer;font-family:inherit">📊 PPT 파일로 저장</button>'+
    '<div style="font-size:11px;color:#aaa;margin-top:8px;line-height:1.6">파워포인트·구글슬라이드·한쇼에서 그대로 열려요. 글꼴과 색은 파일을 연 뒤 바꾸면 돼요.</div>';
}

function pptSave(){
  var d = window._pptDeck; if(!d) return;
  var btn = document.getElementById('ppt-dl');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ 만드는 중…'; }
  podoPptx(d, '포도야_' + (d.title || '발표자료').replace(/[\\/:*?"<>|]/g, '') + '_' + stamp() + '.pptx',
    function(){ if(btn){ btn.disabled = false; btn.textContent = '📊 PPT 파일로 저장'; } });
}

/* ══════════════════════════════════════════════════════════════════
   3. 기존 화면에 버튼 심기 — index.html 수정 없이
   ══════════════════════════════════════════════════════════════════ */
function mkBtn(id, label, onclick, style){
  var b = document.createElement('button');
  b.id = id; b.textContent = label; b.onclick = onclick;
  b.style.cssText = style;
  return b;
}

/* 가계부 시트가 열릴 때 "엑셀로 내보내기" 버튼을 한 번만 붙인다 */
function injectLedgerBtn(){
  var sheet = document.getElementById('ledger-bg');
  if(!sheet || document.getElementById('podo-ledger-xlsx')) return;
  var anchor = document.getElementById('ledger-ai-btn');
  if(!anchor) return;
  var b = mkBtn('podo-ledger-xlsx', '📊 엑셀로 내보내기 (내역·정산)', ledgerXlsx,
    'width:100%;padding:12px;border-radius:12px;border:1px solid rgba(34,197,94,.35);background:rgba(34,197,94,.08);color:#15803d;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:8px');
  anchor.parentNode.insertBefore(b, anchor.nextSibling);
}

/* 금액칸이 날짜칸을 밀어내서 "2026. 08." 로 잘리던 것 — 폭을 다시 나눈다.
   금액은 줄어들 수 있게, 날짜는 절대 줄어들지 않게. */
function fixLedgerFields(){
  var amt = document.getElementById('ledger-amount');
  var day = document.getElementById('ledger-date');
  if(!amt || !day || day.dataset.podoFit) return;
  amt.style.flex = '1 1 auto';
  amt.style.minWidth = '0';
  day.style.flex = '0 0 auto';
  day.style.minWidth = '132px';
  day.style.padding = '12px 7px';
  day.style.fontSize = '12.5px';
  day.style.textAlign = 'center';
  day.dataset.podoFit = '1';
}

/* ── 🍇 포도야 비서 목록에 두 줄 끼워넣기 ─────────────────────────
   비서 화면은 열 때마다 새로 그려지므로 매번 다시 붙인다.
   index.html 의 _asRow 와 똑같은 모양으로 만들어 티가 안 나게 한다. */
function asRowHtml(id, ic, title, sub){
  return '<button id="' + id + '" style="width:100%;display:flex;align-items:center;gap:12px;background:#fff;border:none;border-bottom:1px solid #f1f1f1;padding:14px 4px;cursor:pointer;font-family:inherit;text-align:left">'+
    '<span style="font-size:20px;width:26px;flex-shrink:0">' + ic + '</span>'+
    '<span style="flex:1;min-width:0">'+
      '<span style="display:flex;align-items:center;gap:6px"><span style="font-size:15px;font-weight:800;color:#111">' + title + '</span>'+
      '<span style="font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;background:#f0fdf4;color:#15803d;flex-shrink:0">바로 됨</span></span>'+
      '<span style="display:block;font-size:11.5px;color:#999;margin-top:2px;line-height:1.45">' + sub + '</span>'+
    '</span>'+
    '<span style="color:#ccc;font-size:16px;flex-shrink:0">›</span></button>';
}
function injectAssistRows(){
  var bg = document.getElementById('assist-bg');
  if(!bg || bg.style.display === 'none') return;
  if(bg.querySelector('#podo-as-ledger')) return;

  /* "문서 만들기" 줄을 찾아서 그 바로 아래에 넣는다 */
  var btns = bg.getElementsByTagName('button'), anchor = null;
  for(var i = 0; i < btns.length; i++){
    var oc = btns[i].getAttribute('onclick') || '';
    if(oc.indexOf('asDoc()') >= 0){ anchor = btns[i]; break; }
  }
  if(!anchor || !anchor.parentNode) return;

  var box = document.createElement('div');
  box.innerHTML = asRowHtml('podo-as-ledger', '💰', 'AI 가계부', '영수증 찍으면 경비로 · 엑셀 정산까지')+
                  asRowHtml('podo-as-ppt',    '📊', '발표자료',  '주제만 적으면 파워포인트(.pptx)로');
  var rowLedger = box.children[0], rowPpt = box.children[1];
  rowLedger.onclick = function(){ try{ if(typeof openLedger === 'function') openLedger(); }catch(e){} };
  rowPpt.onclick    = function(){ try{ openPptMaker(); }catch(e){} };

  var after = anchor.nextSibling;
  anchor.parentNode.insertBefore(rowLedger, after);
  anchor.parentNode.insertBefore(rowPpt, rowLedger.nextSibling);
}

/* 문서 결과가 그려지면 "엑셀로" 버튼을 붙인다 */
function injectDocBtn(){
  var out = document.getElementById('doc-out');
  if(!out || !window._docData || document.getElementById('podo-doc-xlsx')) return;
  if(!out.querySelector('button')) return;
  var b = mkBtn('podo-doc-xlsx', '📊 엑셀(.xlsx)로 저장', docXlsx,
    'width:100%;margin-top:7px;padding:11px;border-radius:11px;border:1.5px solid #d9f0e0;background:#f5fbf7;color:#15803d;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit');
  out.appendChild(b);
}

/* 화면이 바뀔 때마다 가볍게 확인 (한 번 붙으면 다시 안 붙음) */
function watch(){
  try{ injectLedgerBtn(); }catch(e){}
  try{ fixLedgerFields(); }catch(e){}
  try{ injectDocBtn(); }catch(e){}
  try{ injectAssistRows(); }catch(e){}
  try{ injectToolsNotice(); }catch(e){}
}
document.addEventListener('click', function(){ setTimeout(watch, 120); }, true);
setInterval(watch, 1200);

/* ══════════════════════════════════════════════════════════════════
   4. 🔐 리서치 도구 — 이용권으로 서버 키 쓰기
   ------------------------------------------------------------------
   순서: ① 내 키가 있으면 내 키 (한도 없음)
         ② 없고 이용권이 있으면 워커 (서버 키)
         ③ 둘 다 없으면 안내
   기존 firecrawlScrape / exaSearch 를 갈아끼운다. 리서치 파이프라인과
   MCP 융합검색이 이 둘을 부르므로, 여기만 바꾸면 전부 살아난다.
   ══════════════════════════════════════════════════════════════════ */
var TOOLS_API = 'https://podoya-tools.hasin7jk.workers.dev';   /* 워커 주소가 다르면 여기만 고치세요 */

function myKey(k){ try{ return (localStorage.getItem(k) || '').trim(); }catch(e){ return ''; } }
function licOn(){ try{ return (typeof licActive === 'function') && licActive(); }catch(e){ return false; } }
function licCodeNow(){ try{ return (window.licCode || '').trim(); }catch(e){ return ''; } }

function toolsCall(path, payload, ok, fail){
  fetch(TOOLS_API + path, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-Podo-Code': licCodeNow() },
    body: JSON.stringify(payload)
  })
  .then(function(r){ return r.json().then(function(d){ return { s:r.status, d:d }; }); })
  .then(function(res){
    if(res.d && res.d.error) throw new Error(res.d.error);
    if(res.s >= 400) throw new Error('요청이 거절됐어요 (' + res.s + ')');
    ok(res.d);
  })
  .catch(function(e){
    var m = (e && e.message) || '실패';
    if(/failed to fetch|networkerror|load failed/i.test(m)) m = '리서치 서버에 연결하지 못했어요. 잠시 뒤 다시 해보세요.';
    fail(new Error(m));
  });
}

var _origScrape = window.firecrawlScrape;
var _origExa    = window.exaSearch;

if(typeof _origScrape === 'function'){
  window.firecrawlScrape = function(url, cb, errcb){
    if(myKey('adv_firecrawl_key')) return _origScrape(url, cb, errcb);
    if(!licOn()){
      errcb(new Error('이용권 코드를 등록하면 키 없이 바로 쓸 수 있어요. (설정 → 이용권)'));
      return;
    }
    toolsCall('/scrape', { url: url }, function(d){
      var md = (d && d.data && (d.data.markdown || d.data.content)) || (d && d.markdown) || '';
      var title = (d && d.data && d.data.metadata && d.data.metadata.title) || '';
      if(!md){ errcb(new Error('내용을 가져오지 못했어요 (빈 결과)')); return; }
      cb(md, title);
    }, errcb);
  };
}

if(typeof _origExa === 'function'){
  window.exaSearch = function(query, cb, errcb){
    if(myKey('adv_exa_key')) return _origExa(query, cb, errcb);
    if(!licOn()){
      errcb(new Error('이용권 코드를 등록하면 키 없이 바로 쓸 수 있어요. (설정 → 이용권)'));
      return;
    }
    toolsCall('/exa', { query: query }, function(d){
      var res = (d && d.results) || [];
      if(!res.length){ errcb(new Error('검색 결과가 없어요')); return; }
      cb(res);
    }, errcb);
  };
}

/* MCP 융합검색이 "Exa 키 있나?"로 켜지고 꺼진다 — 이용권도 열쇠로 인정 */
if(typeof window._mcpHasExa === 'function'){
  window._mcpHasExa = function(){ return !!myKey('adv_exa_key') || licOn(); };
}

/* 고급기능 화면 위에 "이용권으로 바로 됨" 안내 한 줄 */
function injectToolsNotice(){
  var bg = document.getElementById('podoadvf-bg');
  if(!bg || bg.style.display === 'none') return;
  if(!licOn() || bg.querySelector('#podo-tools-notice')) return;
  var w = bg.children[1]; if(!w) return;
  var note = document.createElement('div');
  note.id = 'podo-tools-notice';
  note.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:11px 13px;font-size:13px;color:#15803d;line-height:1.55;margin-bottom:12px';
  note.innerHTML = '🎟️ <b>이용권이 있어서 키 없이 바로 됩니다.</b><br>아래 키 입력칸은 비워두셔도 돼요. 직접 발급한 키를 넣으면 그쪽이 우선 사용됩니다.';
  w.insertBefore(note, w.firstChild);
}

/* ── 전역 공개 ──────────────────────────────────────────────────── */
window.podoXlsx      = podoXlsx;
window.podoPptx      = podoPptx;
window.podoSaveFile  = saveFile;
window.ledgerXlsx    = ledgerXlsx;
window.docXlsx       = docXlsx;
window.openPptMaker  = openPptMaker;
window.closePptMaker = closePptMaker;
window.pptMake       = pptMake;
window.pptPreset     = pptPreset;
window.pptSave       = pptSave;
window.podoToolsCall = toolsCall;

})();
