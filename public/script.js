/*************** ESTADO / AUTH ***************/
let TOKEN = null;
let ME = null;

let SIMULADOS_CACHE = [];        // vem do backend /simulados
let CURRENT_SIM = null;
let CURRENT_QUESTIONS = [];
let ANSWERS = {};

let RESULT = null;               // resposta do backend ao submeter
let BY_AREA = [];                // [{area,total,correct,pct}]
let BY_CONTENT = [];             // [{content,total,correct,pct}]
let CONTENT_AREA = {};           // {content: area}

const charts = { geral:null, subjects:{}, conteudos:null };

/*************** UTILS ***************/
const $ = (sel)=> document.querySelector(sel);
const $$ = (sel)=> document.querySelectorAll(sel);
function show(id){ const el=document.getElementById(id); if(el) el.classList.add('show'); }
function hide(id){ const el=document.getElementById(id); if(el) el.classList.remove('show'); }
function pctColor(p){ if(p>=75) return '#14532D'; if(p>=50) return '#22C55E'; if(p>=25) return '#F59E0B'; return '#EF4444'; }
function destroyAll(){
  if (charts.geral){ charts.geral.destroy(); charts.geral=null; }
  Object.values(charts.subjects).forEach(c=>c && c.destroy());
  charts.subjects = {};
  if (charts.conteudos){ charts.conteudos.destroy(); charts.conteudos=null; }
}
function setActiveRoute(route){
  $$('#navLinks a').forEach(a => a.classList.toggle('active', a.dataset.route===route));
  const views = ['home','simulados','banco','progresso','classes','register'];
  views.forEach(v => {
    const el = document.getElementById('view-'+v);
    if(!el) return;
    if(v===route) el.classList.add('show'); else el.classList.remove('show');
  });
}
function authHeaders(){
  return TOKEN ? { 'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json' } : { 'Content-Type':'application/json' };
}
function formatDate(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' });
  }catch{ return iso || ''; }
}

/*************** ROUTE GUARD ***************/
function requireLogin(route){
  const restricted = ["simulados","banco","progresso","classes"];
  if(!TOKEN && restricted.includes(route)){
    setActiveRoute("register");
    // ativa aba de login por padrão
    switchToTab($('#view-register'), 'login');
    return false;
  }
  return true;
}

/*************** NAV EVENTS ***************/
$('#navToggle')?.addEventListener('click', ()=>$('#navLinks').classList.toggle('show'));
$$('#navLinks a').forEach(a=>{
  a.addEventListener('click', (e)=>{
    e.preventDefault();
    const route = a.dataset.route || 'home';
    if(requireLogin(route)){
      setActiveRoute(route);
      if(route==='simulados'){ renderListaSimulados(); }
      if(route==='progresso'){ openProgresso(); }
    }
  });
});

/*************** TABS (Progresso/Registro) ***************/
document.addEventListener('click', (e)=>{
  if(e.target.classList.contains('tab-btn')){
    const wrap = e.target.closest('.container') || e.target.closest('.card') || document;
    wrap.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    wrap.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('show'));
    e.target.classList.add('active');
    const tab = e.target.dataset.tab;
    const content = wrap.querySelector('#tab-'+tab);
    if(content) content.classList.add('show');
  }
});
function switchToTab(scopeEl, tabName){
  const wrap = scopeEl;
  if(!wrap) return;
  wrap.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===tabName);
  });
  wrap.querySelectorAll('.tab-content').forEach(c=>{
    c.classList.toggle('show', c.id === 'tab-'+tabName);
  });
}

/*************** AUTH FORMS ***************/
function saveToken(t){ TOKEN = t; localStorage.setItem('token', t || ''); }
function loadToken(){ const t = localStorage.getItem('token'); if(t){ TOKEN=t; } }

async function fetchMe(){
  if(!TOKEN) return null;
  try{
    const r = await fetch('/me', { headers: authHeaders() });
    if(!r.ok) throw 0;
    ME = await r.json();
    return ME;
  }catch{
    ME = null; saveToken('');
    return null;
  }
}

async function handleRegister(){
  const form = $('#formRegister');
  if(!form) return;
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    form.querySelector('.form-error')?.remove();
    form.querySelector('.form-success')?.remove();

    const fd = new FormData(form);
    const payload = {
      name: fd.get('name')?.toString().trim(),
      email: fd.get('email')?.toString().trim(),
      password: fd.get('password')?.toString(),
      role: fd.get('role')?.toString()
    };
    try{
      const r = await fetch('/auth/register', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'Erro no cadastro');
      saveToken(data.token);
      ME = data.user;
      // feedback e direcionamento
      const ok = document.createElement('div');
      ok.className = 'form-success';
      ok.textContent = 'Cadastro concluído. Você já está logado!';
      form.appendChild(ok);
      setActiveRoute('home');
    }catch(err){
      const div = document.createElement('div');
      div.className = 'form-error';
      div.textContent = err.message || 'Falha ao cadastrar';
      form.appendChild(div);
    }
  });
}

async function handleLogin(){
  const form = $('#formLogin');
  if(!form) return;
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    form.querySelector('.form-error')?.remove();

    const fd = new FormData(form);
    const payload = {
      email: fd.get('email')?.toString().trim(),
      password: fd.get('password')?.toString()
    };
    try{
      const r = await fetch('/auth/login', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if(!r.ok) throw new Error(data.error || 'Erro no login');
      saveToken(data.token);
      ME = data.user;
      setActiveRoute('home');
    }catch(err){
      const div = document.createElement('div');
      div.className = 'form-error';
      div.textContent = err.message || 'Falha ao entrar';
      form.appendChild(div);
    }
  });
}

/*************** HOME (nada dinâmico por enquanto) ***************/

/*************** SIMULADOS: LISTA + ESTADO ***************/
async function fetchSimulados(){
  const r = await fetch('/simulados', { headers: authHeaders() });
  if(!r.ok) throw new Error('Falha ao obter simulados');
  SIMULADOS_CACHE = await r.json(); // [{id,name,total}]
}
function getStatus(simId){
  const doneKey = `sim-done-${ME?.id || 'anon'}`;
  const done = JSON.parse(localStorage.getItem(doneKey)||'[]');
  return done.includes(simId) ? 'done' : 'pending';
}
function setStatusDone(simId){
  const doneKey = `sim-done-${ME?.id || 'anon'}`;
  const done = JSON.parse(localStorage.getItem(doneKey)||'[]');
  if(!done.includes(simId)){ done.push(simId); localStorage.setItem(doneKey, JSON.stringify(done)); }
}
async function renderListaSimulados(){
  try{
    const wrap = $('#listaSimulados');
    if(!wrap) return;
    await fetchSimulados();
    wrap.innerHTML = SIMULADOS_CACHE.map(s=>{
      const status = getStatus(s.id);
      const label = status==='done' ? 'Concluído' : 'Não feito';
      const dotClass = status==='done' ? 'done' : 'pending';
      return `
        <div class="sim-row">
          <div class="sim-row__left">
            <div class="status"><span class="dot ${dotClass}"></span> ${label}</div>
            <b>${s.name || s.title || ('Simulado '+s.id)}</b>
            <span class="muted">• ${s.total || 0} questões</span>
          </div>
          <div class="sim-row__right">
            <button class="btn small" data-action="start" data-id="${s.id}">Iniciar</button>
          </div>
        </div>
      `;
    }).join('');

    // delegação de eventos
    wrap.querySelectorAll('button[data-action="start"]').forEach(btn=>{
      btn.addEventListener('click', ()=> startSimulado(Number(btn.dataset.id)));
    });

    // prepara seções de resultado
    setupResultadoSections();
  }catch(err){
    console.error(err);
  }
}

/*************** INICIAR SIMULADO ***************/
function setupResultadoSections(){
  // preenche estrutura base das três telas (caso não exista)
  const g = $('#resultado-geral');
  if(g && !g.innerHTML.trim()){
    g.innerHTML = `
      <h3>Resultado — Geral</h3>
      <div class="viz-center" style="height:300px"><canvas id="chartGeral"></canvas></div>
      <div class="legend">
        <span class="badge b4">75–100%</span>
        <span class="badge b3">50–75%</span>
        <span class="badge b2">25–50%</span>
        <span class="badge b1">0–25%</span>
      </div>
      <div class="row end">
        <button class="btn" id="btnToMaterias">Continuar → Por Matéria</button>
      </div>
    `;
  }
  const m = $('#resultado-materias');
  if(m && !m.innerHTML.trim()){
    m.innerHTML = `
      <h3>Resultado — Por Matéria</h3>
      <p class="muted">Cada círculo é normalizado para 100% dentro da própria matéria.</p>
      <div id="gridMaterias" class="grid-subjects"></div>
      <div class="row end">
        <button class="btn ghost" id="btnBackGeral">← Voltar ao Geral</button>
        <button class="btn" id="btnToConteudos">Continuar → Por Conteúdo</button>
      </div>
    `;
  }
  const c = $('#resultado-conteudos');
  if(c && !c.innerHTML.trim()){
    c.innerHTML = `
      <h3>Resultado — Por Conteúdo</h3>
      <div class="row" style="margin-bottom:8px">
        <label>Matéria:&nbsp;
          <select id="selectArea"></select>
        </label>
      </div>
      <div class="viz-wide" style="height:460px">
        <canvas id="chartConteudos"></canvas>
      </div>
      <div class="row end" style="margin-top:10px">
        <button class="btn ghost" id="btnBackMaterias">← Voltar por Matéria</button>
      </div>
    `;
  }
}

async function startSimulado(id){
  CURRENT_SIM = id; ANSWERS = {};
  // backend
  const r = await fetch(`/simulado/${id}`, { headers: authHeaders() });
  if(!r.ok) throw new Error('Falha ao obter questões');
  CURRENT_QUESTIONS = await r.json(); // [{id, area, content, text, options}]

  // mapeia conteúdo->área para filtros depois
  CONTENT_AREA = {}; CURRENT_QUESTIONS.forEach(q => CONTENT_AREA[q.content]=q.area);

  const box = $('#simuladoQuestoes');
  box.style.display = 'block';
  box.innerHTML = `<h3>${(SIMULADOS_CACHE.find(s=>s.id===id)?.name) || 'Simulado'}</h3>` +
    CURRENT_QUESTIONS.map(q=>`
      <div class="qcard">
        <div class="muted">${q.area} • ${q.content}</div>
        <p><b>Q${q.id}.</b> ${q.text}</p>
        ${q.options.map(op=>`
          <label class="option"><input type="radio" name="q${q.id}" value="${op}" onchange="ANSWERS[${q.id}]='${op}'"> ${op}</label>
        `).join('')}
      </div>
    `).join('') +
    `<div class="row end"><button class="btn" id="btnSubmit">Finalizar simulado</button></div>`;

  // esconde resultados enquanto responde
  ['resultado-geral','resultado-materias','resultado-conteudos'].forEach(id=>$('#'+id).style.display='none');

  $('#btnSubmit').addEventListener('click', submitSimulado);
}

/*************** SUBMETER E CALCULAR RESULTADO ***************/
async function submitSimulado(){
  // validação simples: avisa se há muitas em branco
  const total = CURRENT_QUESTIONS.length;
  const answered = Object.keys(ANSWERS).length;
  if(answered < total){
    const conf = confirm(`Você deixou ${total - answered} questão(ões) em branco. Deseja enviar mesmo assim?`);
    if(!conf) return;
  }

  // backend real: envia respostas, recebe score + breakdown e salva histórico
  const r = await fetch(`/simulado/${CURRENT_SIM}/submit`, {
    method:'POST',
    headers: authHeaders(),
    body: JSON.stringify({ answers: ANSWERS })
  });
  const data = await r.json();
  if(!r.ok) { alert(data.error || 'Falha ao enviar'); return; }

  RESULT = { score: Math.round(data.score) };
  BY_AREA = data.byArea || [];
  BY_CONTENT = data.byContent || [];

  // marca como feito (por usuário)
  setStatusDone(CURRENT_SIM);

  // mostra tela geral
  $('#simuladoQuestoes').style.display='none';
  renderTelaGeral();
}

/*************** RESULTADOS — TELA 1: GERAL ***************/
function renderTelaGeral(){
  destroyAll();
  const sec = $('#resultado-geral');
  sec.style.display='block';
  $('#resultado-materias').style.display='none';
  $('#resultado-conteudos').style.display='none';

  const ctx = $('#chartGeral').getContext('2d');
  charts.geral = new Chart(ctx,{
    type:'doughnut',
    data:{
      labels:['Acertos','Erros'],
      datasets:[{ data:[RESULT.score, 100-RESULT.score], backgroundColor:[pctColor(RESULT.score),'#E5E7EB'] }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{
        legend:{display:false},
        datalabels:{
          display:(c)=>c.dataIndex===0,
          formatter:()=>`${RESULT.score}%`,
          color:'#111', font:{weight:'bold',size:20}
        }
      }
    },
    plugins:[ChartDataLabels]
  });

  // navegação
  $('#btnToMaterias').onclick = renderTelaMaterias;
}

/*************** RESULTADOS — TELA 2: POR MATÉRIA ***************/
function renderTelaMaterias(){
  destroyAll();
  $('#resultado-geral').style.display='none';
  const sec = $('#resultado-materias');
  sec.style.display='block';
  $('#resultado-conteudos').style.display='none';

  const grid = $('#gridMaterias');
  grid.innerHTML = '';
  BY_AREA.forEach(a=>{
    const id = `mat-${a.area.toLowerCase().replace(/\s+/g,'-')}`;
    const card = document.createElement('div');
    card.className='subject-card';
    card.innerHTML = `<h5>${a.area}</h5><div style="height:240px"><canvas id="${id}"></canvas></div>`;
    grid.appendChild(card);

    const ctx = $('#'+id).getContext('2d');
    charts.subjects[id] = new Chart(ctx,{
      type:'doughnut',
      data:{ labels:['Acertos','Erros'], datasets:[{ data:[a.pct, 100-a.pct], backgroundColor:[pctColor(a.pct),'#E5E7EB'] }]},
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'70%',
        plugins:{
          legend:{display:false},
          datalabels:{ display:(c)=>c.dataIndex===0, formatter:()=>`${a.pct}%`, color:'#111', font:{weight:'bold',size:16} }
        },
        onClick: ()=> {
          renderTelaConteudos(a.area);
          $('#selectArea').value = a.area;
        }
      },
      plugins:[ChartDataLabels]
    });
  });

  $('#btnBackGeral').onclick = renderTelaGeral;
  $('#btnToConteudos').onclick = ()=>{
    const firstArea = BY_AREA[0]?.area || '';
    renderTelaConteudos(firstArea);
    if(firstArea) $('#selectArea').value = firstArea;
  };
}

/*************** RESULTADOS — TELA 3: POR CONTEÚDO ***************/
function renderTelaConteudos(area){
  destroyAll();
  $('#resultado-geral').style.display='none';
  $('#resultado-materias').style.display='none';
  const sec = $('#resultado-conteudos');
  sec.style.display='block';

  // popula seletor de matéria
  const sel = $('#selectArea');
  sel.innerHTML = BY_AREA.map(a=>`<option value="${a.area}">${a.area}</option>`).join('');
  if(area) sel.value = area;
  sel.onchange = ()=> renderTelaConteudos(sel.value);

  // filtra conteúdos da área selecionada
  const rows = BY_CONTENT.filter(c => CONTENT_AREA[c.content] === (area || sel.value));
  const labels = rows.map(r=>r.content);
  const data = rows.map(r=>r.pct);

  const ctx = $('#chartConteudos').getContext('2d');
  charts.conteudos = new Chart(ctx,{
    type:'bar',
    data:{ labels, datasets:[{ data, backgroundColor:(c)=> pctColor(c.raw) }]},
    options:{
      responsive:true, maintainAspectRatio:false, indexAxis:'y',
      scales:{ x:{ min:0,max:100,ticks:{callback:(v)=>v+'%'} } },
      plugins:{
        legend:{display:false},
        datalabels:{ display:true, align:'end', anchor:'end', formatter:(v)=>v+'%', color:'#111', font:{weight:'bold'} }
      }
    },
    plugins:[ChartDataLabels]
  });

  $('#btnBackMaterias').onclick = renderTelaMaterias;
}

/*************** PROGRESSO ***************/
async function openProgresso(){
  // garantir aba Histórico ativa e carregar
  const view = $('#view-progresso');
  switchToTab(view, 'historico');
  await renderHistorico();
}

async function renderHistorico(){
  const wrap = $('#historicoList');
  if(!wrap) return;
  wrap.innerHTML = `<div class="muted">Carregando...</div>`;
  try{
    const r = await fetch('/me/history', { headers: authHeaders() });
    const arr = await r.json();
    if(!r.ok) throw new Error(arr.error || 'Falha ao obter histórico');

    if(!arr.length){
      wrap.innerHTML = `<div class="card"><b>Nenhum simulado realizado ainda.</b></div>`;
      return;
    }

    wrap.innerHTML = arr.map(a=>{
      const statusDot = a.score>=75 ? 'done' : 'pending';
      const simTitle = (SIMULADOS_CACHE.find(s=>String(s.id)===String(a.simuladoId))?.name) || `Simulado ${a.simuladoId}`;
      return `
        <div class="sim-row">
          <div class="sim-row__left">
            <div class="status"><span class="dot ${statusDot}"></span> ${Math.round(a.score)}%</div>
            <b>${simTitle}</b>
            <span class="muted">• ${formatDate(a.date)}</span>
          </div>
          <div class="sim-row__right">
            <span class="badge">${a.correct}/${a.total} acertos</span>
          </div>
        </div>
      `;
    }).join('');
  }catch(err){
    wrap.innerHTML = `<div class="form-error">${err.message || 'Erro ao carregar histórico'}</div>`;
  }
}

/*************** BOOT ***************/
(async function boot(){
  // forçar nome certo do arquivo: este é script.js (não script.javascript)
  loadToken();
  if(TOKEN){ await fetchMe(); }

  // listeners de cadastro/login
  handleRegister();
  handleLogin();

  // rota inicial
  setActiveRoute('home');

  // se já estiver logado, pré-carrega lista de simulados (para histórico ficar com títulos)
  if(TOKEN){
    try{ await fetchSimulados(); }catch{}
  }
})();
