/*************** ESTADO / AUTH ***************/
let TOKEN = null;
let ME = null;

let SIMULADOS_CACHE = [];        // [{id,name,total}]
let CURRENT_SIM = null;
let CURRENT_QUESTIONS = [];
let ANSWERS = {};

let RESULT = null;               // {score,...}
let BY_AREA = [];                // [{area,total,correct,pct}]
let BY_CONTENT = [];             // [{content,total,correct,pct}]
let CONTENT_AREA = {};           // {content: area}

const charts = { geral:null, subjects:{}, conteudos:null };

/*************** UTILS ***************/
const $ = (sel)=> document.querySelector(sel);
const $$ = (sel)=> document.querySelectorAll(sel);
function show(id){ const el=document.getElementById(id); if(el) el.style.display='block'; }
function hide(id){ const el=document.getElementById(id); if(el) el.style.display='none'; }
function setView(id){ $$('.view').forEach(v=>v.classList.remove('show')); const el=$('#view-'+id); if(el) el.classList.add('show'); }
function pctColor(p){ if(p>=75) return '#14532D'; if(p>=50) return '#22C55E'; if(p>=25) return '#F59E0B'; return '#EF4444'; }
function destroyAll(){
  if (charts.geral){ charts.geral.destroy(); charts.geral=null; }
  Object.values(charts.subjects).forEach(c=>c && c.destroy());
  charts.subjects = {};
  if (charts.conteudos){ charts.conteudos.destroy(); charts.conteudos=null; }
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
function requireLogin(route){
  const restricted = ["simulados","banco","progresso","classes"];
  if(!TOKEN && restricted.includes(route)){
    setView("register");
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
      $$('#navLinks a').forEach(x => x.classList.toggle('active', x===a));
      setView(route);
      if(route==='simulados'){ renderListaSimulados(); }
      if(route==='progresso'){ openProgresso(); }
      if(route==='classes'){ openClasses(); }
    }
  });
});

/*************** TABS ***************/
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

/*************** AUTH ***************/
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

function attachRegisterLogin(){
  const formR = $('#formRegister');
  if (formR){
    formR.addEventListener('submit', async (e)=>{
      e.preventDefault();
      formR.querySelector('.form-error')?.remove();
      formR.querySelector('.form-success')?.remove();
      const fd = new FormData(formR);
      const payload = {
        name: fd.get('name')?.toString().trim(),
        email: fd.get('email')?.toString().trim(),
        password: fd.get('password')?.toString(),
        role: fd.get('role')?.toString()
      };
      try{
        const r = await fetch('/auth/register', {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if(!r.ok) throw new Error(data.error || 'Erro no cadastro');
        saveToken(data.token); ME = data.user;
        const ok = document.createElement('div'); ok.className='form-success';
        ok.textContent='Cadastro concluído. Você já está logado!'; formR.appendChild(ok);
        setView('home');
      }catch(err){
        const div = document.createElement('div');
        div.className='form-error'; div.textContent = err.message || 'Falha ao cadastrar';
        formR.appendChild(div);
      }
    });
  }

  const formL = $('#formLogin');
  if (formL){
    formL.addEventListener('submit', async (e)=>{
      e.preventDefault();
      formL.querySelector('.form-error')?.remove();
      const fd = new FormData(formL);
      const payload = { email: fd.get('email')?.toString().trim(), password: fd.get('password')?.toString() };
      try{
        const r = await fetch('/auth/login', {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if(!r.ok) throw new Error(data.error || 'Erro no login');
        saveToken(data.token); ME = data.user;
        setView('home');
      }catch(err){
        const div = document.createElement('div');
        div.className='form-error'; div.textContent = err.message || 'Falha ao entrar';
        formL.appendChild(div);
      }
    });
  }
}

/*************** SIMULADOS ***************/
async function fetchSimulados(){
  const r = await fetch('/simulados', { headers: authHeaders() });
  if(!r.ok) throw new Error('Falha ao obter simulados');
  SIMULADOS_CACHE = await r.json();
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
  const wrap = $('#listaSimulados');
  if(!wrap) return;
  wrap.innerHTML = `<div class="muted">Carregando...</div>`;
  try{
    await fetchSimulados();
    wrap.innerHTML = SIMULADOS_CACHE.map(s=>{
      const status = getStatus(s.id);
      const label = status==='done' ? 'Concluído' : 'Não feito';
      const dotClass = status==='done' ? 'done' : 'pending';
      return `
        <div class="sim-row">
          <div class="sim-row__left">
            <div class="status"><span class="dot ${dotClass}"></span> ${label}</div>
            <b>${s.name}</b>
            <span class="muted">• ${s.total} questões</span>
          </div>
          <div class="sim-row__right">
            <button class="btn small" data-action="start" data-id="${s.id}">Iniciar</button>
          </div>
        </div>
      `;
    }).join('');
    // eventos
    wrap.querySelectorAll('button[data-action="start"]').forEach(btn=>{
      btn.addEventListener('click', ()=> startSimulado(Number(btn.dataset.id)));
    });
    setupResultadoSections();
  }catch(err){
    wrap.innerHTML = `<div class="form-error">${err.message}</div>`;
  }
}
function setupResultadoSections(){
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
        <label>Matéria:&nbsp;<select id="selectArea"></select></label>
      </div>
      <div class="viz-wide" style="height:460px"><canvas id="chartConteudos"></canvas></div>
      <div id="conteudoQuestoes"></div>
      <div class="row end" style="margin-top:10px">
        <button class="btn ghost" id="btnBackMaterias">← Voltar por Matéria</button>
      </div>
    `;
  }
}
async function startSimulado(id){
  CURRENT_SIM = id; ANSWERS = {};
  const r = await fetch(`/simulado/${id}`, { headers: authHeaders() });
  if(!r.ok) { alert('Falha ao obter questões'); return; }
  CURRENT_QUESTIONS = await r.json();
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
  hide('resultado-geral'); hide('resultado-materias'); hide('resultado-conteudos');
  $('#btnSubmit').addEventListener('click', submitSimulado);
}
async function submitSimulado(){
  const total = CURRENT_QUESTIONS.length;
  const answered = Object.keys(ANSWERS).length;
  if(answered < total){
    const conf = confirm(`Você deixou ${total - answered} questão(ões) em branco. Deseja enviar mesmo assim?`);
    if(!conf) return;
  }
  const r = await fetch(`/simulado/${CURRENT_SIM}/submit`, {
    method:'POST', headers: authHeaders(), body: JSON.stringify({ answers: ANSWERS })
  });
  const data = await r.json();
  if(!r.ok){ alert(data.error || 'Falha ao enviar'); return; }
  RESULT = { score: Math.round(data.score) };
  BY_AREA = data.byArea || [];
  BY_CONTENT = data.byContent || [];
  PER_QUESTIONS = data.perQuestion || [];
  setStatusDone(CURRENT_SIM);
  $('#simuladoQuestoes').style.display='none';
  renderTelaGeral();
}
function renderTelaGeral(){
  destroyAll(); show('resultado-geral'); hide('resultado-materias'); hide('resultado-conteudos');
  const ctx = $('#chartGeral').getContext('2d');
  charts.geral = new Chart(ctx,{
    type:'doughnut',
    data:{ labels:['Acertos','Erros'], datasets:[{ data:[RESULT.score, 100-RESULT.score], backgroundColor:[pctColor(RESULT.score),'#E5E7EB'] }]},
    options:{ responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{ legend:{display:false}, datalabels:{ display:(c)=>c.dataIndex===0, formatter:()=>`${RESULT.score}%`, color:'#111', font:{weight:'bold',size:20} } }
    }, plugins:[ChartDataLabels]
  });
  $('#btnToMaterias').onclick = renderTelaMaterias;
}
function renderTelaMaterias(){
  destroyAll(); hide('resultado-geral'); show('resultado-materias'); hide('resultado-conteudos');
  const grid = $('#gridMaterias'); grid.innerHTML = '';
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
      options:{ responsive:true, maintainAspectRatio:false, cutout:'70%',
        plugins:{ legend:{display:false}, datalabels:{ display:(c)=>c.dataIndex===0, formatter:()=>`${a.pct}%`, color:'#111', font:{weight:'bold',size:16} } },
        onClick: ()=> { renderTelaConteudos(a.area); $('#selectArea').value = a.area; }
      }, plugins:[ChartDataLabels]
    });
  });
  $('#btnBackGeral').onclick = renderTelaGeral;
  $('#btnToConteudos').onclick = ()=>{
    const firstArea = BY_AREA[0]?.area || '';
    renderTelaConteudos(firstArea);
    if(firstArea) $('#selectArea').value = firstArea;
  };
}
function renderTelaConteudos(area){
  destroyAll(); hide('resultado-geral'); hide('resultado-materias'); show('resultado-conteudos');
  const sel = $('#selectArea');
  sel.innerHTML = BY_AREA.map(a=>`<option value="${a.area}">${a.area}</option>`).join('');
  if(area) sel.value = area;
  sel.onchange = ()=> renderTelaConteudos(sel.value);
  const rows = BY_CONTENT.filter(c => CONTENT_AREA[c.content] === (area || sel.value));
  const labels = rows.map(r=>r.content);
  const data = rows.map(r=>r.pct);
  const ctx = $('#chartConteudos').getContext('2d');
  charts.conteudos = new Chart(ctx,{
    type:'bar',
    data:{ labels, datasets:[{ data, backgroundColor:(c)=> pctColor(c.raw) }]},
    options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y',
      scales:{ x:{ min:0,max:100,ticks:{callback:(v)=>v+'%'} } },
      plugins:{ legend:{display:false}, datalabels:{ display:true, align:'end', anchor:'end', formatter:(v)=>v+'%', color:'#111', font:{weight:'bold'} } }
    }, plugins:[ChartDataLabels]
  });
  $('#btnBackMaterias').onclick = renderTelaMaterias;

  // Questões detalhadas do conteúdo
  const qbox = $('#conteudoQuestoes');
  const questoes = PER_QUESTIONS.filter(q => CONTENT_AREA[q.content] === (area || sel.value));
  qbox.innerHTML = questoes.map(q=>`
    <div class="qcard ${q.hit ? 'hit':'miss'}">
      <div class="muted">${q.area} • ${q.content}</div>
      <p><b>Q${q.id}.</b> ${q.text}</p>
      ${q.options.map(op=>`
        <div class="option ${op===q.correct?'correct':(op===q.chosen?'chosen':'')}">
          ${op} ${op===q.correct?'✔':(op===q.chosen && op!==q.correct?'✘':'')}
        </div>
      `).join('')}
    </div>
  `).join('');
}

/*************** PROGRESSO ***************/
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
            <button class="btn small" data-detail="${a.id}">Ver Detalhes</button>
          </div>
        </div>
      `;
    }).join('');

    // evento para abrir detalhes
wrap.querySelectorAll('button[data-detail]').forEach(btn=>{
  btn.onclick = () => {
    const attemptId = btn.getAttribute('data-detail');
    if(attemptId) openDetalheHistorico(attemptId);
  };
});

  }catch(err){
    wrap.innerHTML = `<div class="form-error">${err.message || 'Erro ao carregar histórico'}</div>`;
  }
}

async function openDetalheHistorico(attemptId){
  const r = await fetch(`/attempt/${attemptId}`, { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok){ alert(data.error || 'Erro ao carregar detalhes'); return; }

  RESULT = { score: Math.round(data.score) };
  BY_AREA = data.byArea || [];
  BY_CONTENT = data.byContent || [];
  CONTENT_AREA = {};
  (data.perQuestion || []).forEach(q => CONTENT_AREA[q.content] = q.area);

  // guarda questões e respostas para renderizar lista
  CURRENT_QUESTIONS = data.perQuestion || [];

  // renderiza a mesma tela de resultado que aparece após o simulado
  renderTelaGeral();

// mostra também a lista de questões abaixo do gráfico
const box = $('#resultado-conteudos');
if(box){
  box.innerHTML = ''; // limpa antes
  const htmlQuestoes = (data.perQuestion||[]).map(q=>`
    <div class="qcard ${q.hit ? 'hit':'miss'}">
      <div class="muted">${q.area} • ${q.content}</div>
      <p><b>Q${q.id}.</b> ${q.text}</p>
      <div>Sua resposta: <b>${q.chosen || '-'}</b></div>
      <div>Resposta correta: <b>${q.correct}</b></div>
    </div>
  `).join('');
  box.insertAdjacentHTML('beforeend', `<h4>Questões</h4>${htmlQuestoes}`);
}

/*************** CLASSES ***************/
async function openClasses(){
  if(ME?.role !== 'teacher'){
    $('#view-classes').innerHTML = `<div class="container"><h2>Classes</h2><p class="muted">Apenas professores têm acesso a esta área.</p></div>`;
    return;
  }
  await ensureSimSelects();
  attachTurmaUI();
  attachAlunoUI();
  await loadTurmas();
}

async function ensureSimSelects(){
  if (!SIMULADOS_CACHE.length){
    try { await fetchSimulados(); } catch {}
  }
  const turmaSel = $('#turmaSimSelect');
  if (turmaSel){
    turmaSel.innerHTML = SIMULADOS_CACHE.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }
}
function attachTurmaUI(){
  const form = $('#formNovaTurma');
  if (form && !form.dataset.bound){
    form.dataset.bound = '1';
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const fd = new FormData(form);
      const name = (fd.get('name')||'').toString().trim();
      if(!name) return;
      const r = await fetch('/classes', {
        method:'POST', headers: authHeaders(), body: JSON.stringify({ name })
      });
      const data = await r.json();
      if(!r.ok){ alert(data.error || 'Erro ao criar turma'); return; }
      form.reset();
      await loadTurmas();
    });
  }

  const btnAdd = $('#btnAddAluno');
  if (btnAdd && !btnAdd.dataset.bound){
    btnAdd.dataset.bound = '1';
    btnAdd.addEventListener('click', async ()=>{
      const email = ($('#alunoEmail')?.value || '').trim();
      const classId = btnAdd.dataset.classId;
      if(!email || !classId){ alert('Selecione uma turma e informe o email'); return; }
      const r = await fetch(`/classes/${classId}/add-student`, {
        method:'POST', headers: authHeaders(), body: JSON.stringify({ studentEmail: email })
      });
      const data = await r.json();
      if(!r.ok){ alert(data.error || 'Erro ao adicionar aluno'); return; }
      $('#alunoEmail').value = '';
      await openTurmaDetalhe(classId);
    });
  }

  const btnRep = $('#btnLoadReport');
  if (btnRep && !btnRep.dataset.bound){
    btnRep.dataset.bound = '1';
    btnRep.addEventListener('click', async ()=>{
      const classId = btnRep.dataset.classId;
      const simId = Number($('#turmaSimSelect')?.value || 1);
      if(!classId){ alert('Selecione uma turma'); return; }
      await loadTurmaReport(classId, simId);
    });
  }
}
function attachAlunoUI(){
  const alunoTurmaSelect = $('#alunoTurmaSelect');
  if (alunoTurmaSelect && !alunoTurmaSelect.dataset.bound){
    alunoTurmaSelect.dataset.bound='1';
    alunoTurmaSelect.addEventListener('change', async ()=>{
      const cid = alunoTurmaSelect.value;
      await loadAlunosDaTurma(cid);
    });
  }
}
async function loadTurmas(){
  const wrap = $('#listaTurmas');
  if(!wrap) return;
  wrap.innerHTML = `<div class="muted">Carregando...</div>`;
  const r = await fetch('/classes', { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok){ wrap.innerHTML = `<div class="form-error">${data.error || 'Erro'}</div>`; return; }
  if(!data.length){ wrap.innerHTML = `<div class="card"><b>Nenhuma turma criada ainda.</b></div>`; return; }
  const sel = $('#alunoTurmaSelect');
  if(sel){ sel.innerHTML = data.map(t=>`<option value="${t.id}">${t.name}</option>`).join(''); }

  wrap.innerHTML = data.map(t=>`
    <div class="sim-row">
      <div class="sim-row__left">
        <b>${t.name}</b>
        <span class="muted">• id ${t.id.slice(0,8)}...</span>
      </div>
      <div class="sim-row__right">
        <button class="btn small" data-open="${t.id}">Abrir</button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('button[data-open]').forEach(btn=>{
    btn.addEventListener('click', ()=> openTurmaDetalhe(btn.dataset.open));
  });
  if (sel && data[0]) {
    sel.value = data[0].id;
    await loadAlunosDaTurma(data[0].id);
  }
}
async function openTurmaDetalhe(classId){
  const r = await fetch(`/classes/${classId}`, { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok){ alert(data.error || 'Erro ao abrir turma'); return; }
  $('#turmaNome').textContent = data.name;
  const alunos = data.students || [];
  $('#turmaAlunos').innerHTML = alunos.length
    ? alunos.map(a=>`<div class="sim-row"><div class="sim-row__left"><b>${a.name}</b><span class="muted">• ${a.email}</span></div></div>`).join('')
    : `<div class="card">Nenhum aluno ainda.</div>`;
  $('#btnAddAluno').dataset.classId = classId;
  $('#btnLoadReport').dataset.classId = classId;
  show('turmaDetalhe');
  $('#turmaReport').innerHTML = `<div class="muted">Selecione um simulado e clique em "Carregar".</div>`;
}
async function loadTurmaReport(classId, simId){
  const r = await fetch(`/classes/${classId}/report?simulado=${simId}`, { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok){ alert(data.error || 'Erro ao carregar relatório'); return; }
  const rep = $('#turmaReport');
  const area = (data.byArea||[]).map(x=>`
    <div class="rowb"><div>${x.area}</div><div>${x.total}</div><div>${x.correct}</div><div>${x.pct}%</div></div>
  `).join('') || `<div class="muted">Sem dados ainda.</div>`;
  const cont = (data.byContent||[]).map(x=>`
    <div class="rowb"><div>${x.content}</div><div>${x.total}</div><div>${x.correct}</div><div>${x.pct}%</div></div>
  `).join('') || `<div class="muted">Sem dados ainda.</div>`;
  const studs = (data.students||[]).map(s=>`
    <div class="sim-row"><div class="sim-row__left"><b>${s.student}</b></div><div class="sim-row__right"><span class="badge">${s.score}%</span></div></div>
  `).join('') || `<div class="muted">Nenhum aluno avaliável ainda.</div>`;
  rep.innerHTML = `
    <h5>Média da turma: ${data.average || 0}%</h5>
    <div class="two-cols">
      <div><div class="table-like"><div class="rowh"><div>Matéria</div><div>Total</div><div>Acertos</div><div>%</div></div>${area}</div></div>
      <div><div class="table-like"><div class="rowh"><div>Conteúdo</div><div>Total</div><div>Acertos</div><div>%</div></div>${cont}</div></div>
    </div>
    <h5 style="margin-top:10px;">Alunos</h5>
    ${studs}
  `;
}
async function loadAlunosDaTurma(classId){
  if(!classId){ $('#listaAlunos').innerHTML = `<div class="muted">Selecione uma turma.</div>`; return; }
  const r = await fetch(`/classes/${classId}`, { headers: authHeaders() });
  const data = await r.json();
  if(!r.ok){ $('#listaAlunos').innerHTML = `<div class="form-error">${data.error || 'Erro'}</div>`; return; }
  const alunos = data.students || [];
  const list = $('#listaAlunos');
  list.innerHTML = alunos.length
    ? alunos.map(a=>`
      <div class="sim-row">
        <div class="sim-row__left"><b>${a.name}</b> <span class="muted">• ${a.email}</span></div>
        <div class="sim-row__right"><button class="btn small" data-open-stu="${a.id}" data-stuname="${a.name}">Abrir</button></div>
      </div>
    `).join('')
    : `<div class="card">Nenhum aluno nessa turma.</div>`;
  list.querySelectorAll('button[data-open-stu]').forEach(btn=>{
    btn.addEventListener('click', ()=> openAlunoDetalhe(btn.dataset.openStu, btn.dataset.stuname));
  });
}
async function openAlunoDetalhe(studentId, studentName){
  $('#alunoNome').textContent = studentName || 'Aluno';
  const cont = $('#alunoHistorico');
  cont.innerHTML = `<div class="muted">Carregando...</div>`;
  const r = await fetch(`/me/history?userId=${encodeURIComponent(studentId)}`, { headers: authHeaders() });
  const arr = await r.json();
  if(!r.ok){ cont.innerHTML = `<div class="form-error">${arr.error || 'Erro'}</div>`; return; }
  if(!arr.length){ cont.innerHTML = `<div class="card">Este aluno ainda não fez simulados.</div>`; show('detalheAluno'); return; }
  cont.innerHTML = arr.map(a=>{
    const simTitle = (SIMULADOS_CACHE.find(s=>String(s.id)===String(a.simuladoId))?.name) || `Simulado ${a.simuladoId}`;
    return `
      <div class="sim-row">
        <div class="sim-row__left"><b>${simTitle}</b><span class="muted">• ${formatDate(a.date)}</span></div>
        <div class="sim-row__right"><button class="btn small" onclick="abrirDetalheHistorico('${a.id}')">Ver Detalhes</button></div>
      </div>
    `;
  }).join('');
  show('detalheAluno');
}

/*************** BOOT ***************/
(async function boot(){
  loadToken();
  if(TOKEN){ await fetchMe(); }
  attachRegisterLogin();
  setView('home');
  if(TOKEN){
    try{ await fetchSimulados(); }catch{}
  }
})();


