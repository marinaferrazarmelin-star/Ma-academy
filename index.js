// Backend do GABARITA
require('dotenv').config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const ATTEMPTS_PATH = path.join(DATA_DIR, "attempts.json");
const CLASSES_PATH = path.join(DATA_DIR, "classes.json");
const QUESTIONS_PATH = path.join(DATA_DIR, "questions.json");
const SIMULADOS_META_PATH = path.join(DATA_DIR, "simulados_meta.json");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-later";
const PORT = process.env.PORT || 3000;

// garante data/ e arquivos básicos
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf-8");
  }
}

ensureFile(USERS_PATH, []);
ensureFile(ATTEMPTS_PATH, []);
ensureFile(CLASSES_PATH, []);
ensureFile(QUESTIONS_PATH, { "1": [] });

// meta dos simulados (nome, tipo)
ensureFile(SIMULADOS_META_PATH, {
  "1": { name: "ENEM 2024 – Dia 1", type: "official" }
});

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8") || "null");
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// carrega questões (em memória)
let QUESTIONS = read(QUESTIONS_PATH);
let SIM_META = read(SIMULADOS_META_PATH);

// garante que todo simulado existente tenha meta
function ensureMetaForSimulados() {
  const keys = Object.keys(QUESTIONS || {});
  let changed = false;
  keys.forEach(k => {
    if (!SIM_META[String(k)]) {
      SIM_META[String(k)] = {
        name: String(k) === "1" ? "ENEM 2024 – Dia 1" : `Simulado ${k}`,
        type: "official"
      };
      changed = true;
    }
  });
  if (changed) write(SIMULADOS_META_PATH, SIM_META);
}
ensureMetaForSimulados();

function getSimName(simId) {
  return (SIM_META[String(simId)] || {}).name || `Simulado ${simId}`;
}

/*************** AUTH ***************/
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

/*************** FILTRO DE QUESTÕES ***************/
function parseListParam(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value
      .flatMap(v => String(v).split(","))
      .map(s => s.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function matchesAllTags(questionTags, requiredTags) {
  if (!requiredTags || requiredTags.length === 0) return true;
  const set = new Set(questionTags || []);
  return requiredTags.every(t => set.has(t));
}

function normalize(v) {
  return (v ?? "").toString().trim();
}

/**
 * Modelo suportado (aceita migração gradual):
 * - materia: q.area OU q.subject
 * - tema: q.theme OU (fallback q.content)
 * - subtema: q.subtheme OU (fallback q.subtopic)
 * - origem: q.examType OU q.origin
 * - difficulty, tags, year, text
 */
function filterQuestionsArray(allQuestions, query) {
  const examTypes = parseListParam(query.examType || query.origin);
  const materias = parseListParam(query.materia || query.subject || query.area);

  const temas = parseListParam(query.tema || query.theme);
  const subtemas = parseListParam(query.subtema || query.subtheme);

  const difficulties = parseListParam(query.difficulty);
  const tags = parseListParam(query.tags);

  const yearMin = query.yearMin ? Number(query.yearMin) : null;
  const yearMax = query.yearMax ? Number(query.yearMax) : null;

  const search = query.search ? normalize(query.search).toLowerCase() : null;

  return allQuestions.filter(q => {
    const materia = normalize(q.subject || q.area);
    const tema = normalize(q.theme || q.content);
    const subtema = normalize(q.subtheme || q.subtopic);

    const examType = normalize(q.examType || q.origin);
    const difficulty = normalize(q.difficulty);
    const year = q.year != null ? Number(q.year) : null;

    if (examTypes && !examTypes.includes(examType)) return false;
    if (materias && !materias.includes(materia)) return false;

    if (temas && !temas.includes(tema)) return false;
    if (subtemas && !subtemas.includes(subtema)) return false;

    if (difficulties && !difficulties.includes(difficulty)) return false;

    if (yearMin !== null && year !== null && year < yearMin) return false;
    if (yearMax !== null && year !== null && year > yearMax) return false;

    if (!matchesAllTags(q.tags, tags)) return false;

    if (search) {
      const hay = `${q.text || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }

    return true;
  });
}

/**
 * Junta questões de um simulado específico ou de todos.
 * query.simulado:
 *  - "1" (default) => só simulado 1
 *  - "all" => todos os simulados
 */
function getQuestionsScope(query) {
  const simulado = query.simulado ? String(query.simulado) : "1";

  if (simulado === "all") {
    const all = [];
    Object.keys(QUESTIONS || {}).forEach(k => {
      const arr = QUESTIONS[k] || [];
      arr.forEach(q => all.push({ ...q, simuladoId: String(k) }));
    });
    return all;
  }

  const arr = (QUESTIONS && QUESTIONS[simulado]) ? QUESTIONS[simulado] : [];
  return arr.map(q => ({ ...q, simuladoId: String(simulado) }));
}

/*************** ROTAS BANCO ***************/
// GET /questions?simulado=all&materia=Matemática,Física&tema=Geometria&subtema=Trigonometria
app.get("/questions", auth, (req, res) => {
  const scope = getQuestionsScope(req.query);
  const filtered = filterQuestionsArray(scope, req.query);

  const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1;
  const pageSize = req.query.pageSize ? Math.min(200, Math.max(1, Number(req.query.pageSize))) : 30;

  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  // devolve sem answer (para não vazar gabarito no banco)
  const safeItems = items.map(({ answer, ...rest }) => rest);

  res.json({
    total: filtered.length,
    page,
    pageSize,
    items: safeItems
  });
});

/**
 * Criar simulado custom:
 * body:
 * {
 *   "name":"Revisão de Trigonometria",
 *   "questions":[ {"simuladoId":"1","id":12}, {"simuladoId":"1","id":15} ]
 * }
 */
app.post("/simulados/custom", auth, (req, res) => {
  const { name, questions } = req.body || {};
  const cleanName = String(name || "").trim();
  if (!cleanName) return res.status(400).json({ error: "name required" });

  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "questions required" });
  }

  // id novo (string)
  const newId = String(Date.now());

  // busca as questões reais (com answer) na base
  const selected = [];
  for (const ref of questions) {
    const sid = String(ref.simuladoId || "");
    const qid = ref.id;

    const src = (QUESTIONS[sid] || []).find(q => String(q.id) === String(qid));
    if (src) selected.push({ ...src });
  }

  if (!selected.length) {
    return res.status(400).json({ error: "no valid questions found" });
  }

  QUESTIONS[newId] = selected;
  write(QUESTIONS_PATH, QUESTIONS);

  SIM_META = read(SIMULADOS_META_PATH);
  SIM_META[newId] = { name: cleanName, type: "custom" };
  write(SIMULADOS_META_PATH, SIM_META);

  res.json({ id: newId, name: cleanName, total: selected.length });
});

/*************** AUTH ROUTES ***************/
// registro
app.post("/auth/register", (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "name, email, password, role required" });
  if (!["student", "teacher"].includes(role))
    return res.status(400).json({ error: "role must be student or teacher" });

  const users = read(USERS_PATH);
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: "email already registered" });

  const user = {
    id: uuidv4(),
    name,
    email,
    role,
    passwordHash: bcrypt.hashSync(password, 12),
  };
  users.push(user);
  write(USERS_PATH, users);

  return res.json({
    token: signToken(user),
    user: { id: user.id, name, email, role },
  });
});

// login
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const users = read(USERS_PATH);
  const user = users.find(
    (u) => u.email.toLowerCase() === (email || "").toLowerCase()
  );
  if (!user || !bcrypt.compareSync(password || "", user.passwordHash))
    return res.status(401).json({ error: "invalid credentials" });

  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// perfil
app.get("/me", auth, (req, res) => {
  const users = read(USERS_PATH);
  const me = users.find((u) => u.id === req.user.id);
  res.json({
    id: me.id,
    name: me.name,
    email: me.email,
    role: me.role,
  });
});

/*************** SIMULADOS ***************/
app.get("/simulados", auth, (req, res) => {
  SIM_META = read(SIMULADOS_META_PATH);

  const list = Object.keys(QUESTIONS).map((k) => ({
    id: String(k),
    name: getSimName(k),
    total: (QUESTIONS[k] || []).length,
    type: (SIM_META[String(k)] || {}).type || "official",
  }));

  res.json(list);
});

app.get("/simulado/:id", auth, (req, res) => {
  const sim = QUESTIONS[req.params.id] || [];

  // devolve no formato atual do seu front (area/content),
  // mas já respeita theme/subtheme se existirem.
  const safe = sim.map(({ id, area, subject, content, theme, subtheme, subtopic, text, options, origin, examType }) => ({
    id,
    area: area || subject || "",
    content: content || theme || "",
    subtheme: subtheme || subtopic || "",
    origin: origin || examType || "",
    text,
    options,
  }));
  res.json(safe);
});

app.post("/simulado/:id/submit", auth, (req, res) => {
  const simId = String(req.params.id);
  const answers = (req.body && req.body.answers) || {};
  const simQ = QUESTIONS[simId] || [];

  let correct = 0;
  const byArea = {}, byContent = {}, perQuestion = [];

  simQ.forEach((q) => {
    const isCorrect =
      String(answers[q.id] || "").trim() === String(q.answer).trim();
    if (isCorrect) correct++;

    const materia = q.area || q.subject || "";
    const tema = q.content || q.theme || "";
    const subtema = q.subtheme || q.subtopic || "";
    const origem = q.origin || q.examType || "";

    perQuestion.push({
      id: q.id,
      area: materia,
      content: tema,
      subtheme: subtema,
      origin: origem,
      text: q.text,
      options: q.options,
      chosen: answers[q.id] || null,
      correct: q.answer,
      hit: isCorrect,
    });

    if (!byArea[materia]) byArea[materia] = { total: 0, correct: 0 };
    byArea[materia].total++;
    if (isCorrect) byArea[materia].correct++;

    const key = tema || materia;
    if (!byContent[key]) byContent[key] = { total: 0, correct: 0 };
    byContent[key].total++;
    if (isCorrect) byContent[key].correct++;
  });

  const total = simQ.length || 1;
  const score = (correct / total) * 100;

  const areaArray = Object.entries(byArea).map(([area, s]) => ({
    area,
    total: s.total,
    correct: s.correct,
    pct: Math.round((s.correct / s.total) * 100),
  }));
  const contentArray = Object.entries(byContent).map(([content, s]) => ({
    content,
    total: s.total,
    correct: s.correct,
    pct: Math.round((s.correct / s.total) * 100),
  }));

  const attempts = read(ATTEMPTS_PATH);
  attempts.push({
    id: uuidv4(),
    userId: req.user.id,
    simuladoId: simId,
    simuladoName: getSimName(simId), // ✅ guarda o nome do simulado
    date: new Date().toISOString(),
    score,
    total,
    correct,
    byArea: areaArray,
    byContent: contentArray,
    perQuestion
  });
  write(ATTEMPTS_PATH, attempts);

  res.json({
    score,
    total,
    correct,
    byArea: areaArray,
    byContent: contentArray,
    perQuestion,
  });
});

// histórico do aluno
app.get("/me/history", auth, (req, res) => {
  const userId = req.query.userId || req.user.id;
  const attempts = read(ATTEMPTS_PATH).filter((a) => a.userId === userId);

  const fixed = attempts.map(a => ({
    ...a,
    simuladoName: a.simuladoName || getSimName(a.simuladoId)
  }));

  res.json(fixed.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// detalhes de um attempt específico
app.get("/attempt/:id", auth, (req,res)=>{
  const attempts = read(ATTEMPTS_PATH);
  let att = attempts.find(a => a.id === req.params.id);

  if(!att) return res.status(404).json({ error:"attempt not found" });

  if(req.user.role === "student" && att.userId !== req.user.id){
    return res.status(403).json({ error:"forbidden" });
  }

  att.simuladoName = att.simuladoName || getSimName(att.simuladoId);
  res.json(att);
});

/*************** PROFESSOR / TURMA ***************/
function mustTeacher(req, res, next) {
  if (req.user.role !== "teacher")
    return res.status(403).json({ error: "teacher only" });
  next();
}

app.post("/classes", auth, mustTeacher, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const classes = read(CLASSES_PATH);
  const cls = {
    id: uuidv4(),
    name,
    teacherId: req.user.id,
    studentIds: [],
  };
  classes.push(cls);
  write(CLASSES_PATH, classes);
  res.json(cls);
});

app.get("/classes", auth, mustTeacher, (req, res) => {
  const classes = read(CLASSES_PATH).filter((c) => c.teacherId === req.user.id);
  res.json(classes);
});

app.get("/classes/:id", auth, mustTeacher, (req, res) => {
  const classes = read(CLASSES_PATH);
  const users = read(USERS_PATH);
  const cls = classes.find((c) => c.id === req.params.id && c.teacherId === req.user.id);
  if (!cls) return res.status(404).json({ error: "class not found" });
  const students = users.filter((u) => cls.studentIds.includes(u.id));
  res.json({ ...cls, students });
});

app.post("/classes/:id/add-student", auth, mustTeacher, (req, res) => {
  const { studentEmail } = req.body || {};
  if (!studentEmail)
    return res.status(400).json({ error: "studentEmail required" });

  const users = read(USERS_PATH);
  const student = users.find(
    (u) =>
      u.email.toLowerCase() === studentEmail.toLowerCase() &&
      u.role === "student"
  );
  if (!student) return res.status(404).json({ error: "student not found" });

  const classes = read(CLASSES_PATH);
  const cls = classes.find(
    (c) => c.id === req.params.id && c.teacherId === req.user.id
  );
  if (!cls) return res.status(404).json({ error: "class not found" });

  if (!cls.studentIds.includes(student.id)) cls.studentIds.push(student.id);
  write(CLASSES_PATH, classes);
  res.json(cls);
});

app.get("/classes/:id/report", auth, mustTeacher, (req, res) => {
  const simId = String(req.query.simulado || 1);
  const classes = read(CLASSES_PATH);
  const attempts = read(ATTEMPTS_PATH);
  const users = read(USERS_PATH);

  const cls = classes.find(
    (c) => c.id === req.params.id && c.teacherId === req.user.id
  );
  if (!cls) return res.status(404).json({ error: "class not found" });

  const studs = cls.studentIds;
  const attemptsClass = attempts.filter(
    (a) => String(a.simuladoId) === simId && studs.includes(a.userId)
  );

  const avg = attemptsClass.length
    ? attemptsClass.reduce((s, a) => s + a.score, 0) / attemptsClass.length
    : 0;

  const agg = (arr, key) => {
    const map = {};
    arr.forEach((a) =>
      (a[key] || []).forEach((x) => {
        const k = key === "byArea" ? x.area : x.content;
        if (!map[k]) map[k] = { total: 0, correct: 0 };
        map[k].total += x.total;
        map[k].correct += x.correct;
      })
    );
    return Object.entries(map).map(([k, v]) => ({
      [key === "byArea" ? "area" : "content"]: k,
      total: v.total,
      correct: v.correct,
      pct: Math.round((v.correct / v.total) * 100 || 0),
    }));
  };

  const byArea = agg(attemptsClass, "byArea");
  const byContent = agg(attemptsClass, "byContent");
  const students = attemptsClass.map((a) => ({
    student: (users.find((u) => u.id === a.userId) || {}).name || "Aluno",
    score: Math.round(a.score),
  }));

  res.json({
    class: { id: cls.id, name: cls.name },
    simuladoId: simId,
    average: Math.round(avg),
    byArea,
    byContent,
    students,
  });
});

app.listen(PORT, () =>
  console.log(`✔ Server on http://localhost:${PORT}`)
);
