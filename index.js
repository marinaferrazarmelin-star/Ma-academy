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

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8") || "null");
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// carrega questões (em memória)
let QUESTIONS = read(QUESTIONS_PATH);

// -------------- AUTH --------------
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

// -------------- SIMULADOS --------------
app.get("/simulados", auth, (req, res) => {
  const list = Object.keys(QUESTIONS).map((k) => ({
    id: Number(k),
    name: k === "1" ? "ENEM 2024 – Dia 1" : `Simulado ${k}`,
    total: (QUESTIONS[k] || []).length,
  }));
  res.json(list);
});

app.get("/simulado/:id", auth, (req, res) => {
  const sim = QUESTIONS[req.params.id] || [];
  const safe = sim.map(({ id, area, content, text, options }) => ({
    id,
    area,
    content,
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
    perQuestion.push({
      id: q.id,
      area: q.area,
      content: q.content,
      text: q.text,
      options: q.options,
      chosen: answers[q.id] || null,
      correct: q.answer,
      hit: isCorrect,
    });

    if (!byArea[q.area]) byArea[q.area] = { total: 0, correct: 0 };
    byArea[q.area].total++;
    if (isCorrect) byArea[q.area].correct++;

    const key = q.content || q.area;
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
  res.json(attempts.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// detalhes de um attempt específico
app.get("/attempt/:id", auth, (req,res)=>{
  const attempts = read(ATTEMPTS_PATH);
  const att = attempts.find(a => a.id === req.params.id && a.userId === req.user.id);
  if(!att) return res.status(404).json({ error:"attempt not found" });
  res.json(att);
});

// -------------- PROFESSOR / TURMA --------------
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
