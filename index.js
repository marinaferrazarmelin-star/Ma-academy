// Backend do GABARITA
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-later";
const PORT = process.env.PORT || 3000;

// ----------------- DATABASE -----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// função para rodar init.sql automaticamente
async function runMigrations() {
  const initPath = path.join(__dirname, "init.sql");
  if (!fs.existsSync(initPath)) {
    console.log("⚠ init.sql não encontrado, pulando migrations");
    return;
  }
  const sql = fs.readFileSync(initPath, "utf8");
  try {
    await pool.query(sql);
    console.log("✅ init.sql executado com sucesso");
  } catch (err) {
    console.error("❌ Erro ao rodar init.sql:", err);
  }
}

// helper para query
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// ----------------- AUTH -----------------
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
app.post("/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "name, email, password, role required" });
  if (!["student", "teacher"].includes(role))
    return res.status(400).json({ error: "role must be student or teacher" });

  const users = await query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
  if (users.length) return res.status(409).json({ error: "email already registered" });

  const user = {
    id: uuidv4(),
    name,
    email,
    role,
    passwordHash: bcrypt.hashSync(password, 12)
  };

  await query(
    "INSERT INTO users (id, name, email, role, password_hash) VALUES ($1,$2,$3,$4,$5)",
    [user.id, user.name, user.email, user.role, user.passwordHash]
  );

  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

// login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const users = await query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
  const user = users[0];
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "invalid credentials" });

  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

// perfil
app.get("/me", auth, async (req, res) => {
  const users = await query("SELECT * FROM users WHERE id=$1", [req.user.id]);
  const me = users[0];
  res.json({
    id: me.id,
    name: me.name,
    email: me.email,
    role: me.role
  });
});

// ----------------- SIMULADOS -----------------
// lista de simulados
app.get("/simulados", auth, async (req, res) => {
  const sims = await query("SELECT DISTINCT sim_id FROM questions ORDER BY sim_id ASC");
  const list = [];
  for (let s of sims) {
    const count = await query("SELECT COUNT(*) FROM questions WHERE sim_id=$1", [s.sim_id]);
    list.push({
      id: s.sim_id,
      name: s.sim_id === 1 ? "ENEM 2024 – Dia 1" : `Simulado ${s.sim_id}`,
      total: parseInt(count[0].count, 10)
    });
  }
  res.json(list);
});

// questões de um simulado
app.get("/simulado/:id", auth, async (req, res) => {
  const sim = await query(
    "SELECT id, area, content, text, options FROM questions WHERE sim_id=$1",
    [req.params.id]
  );
  res.json(sim);
});

// envio de respostas
app.post("/simulado/:id/submit", auth, async (req, res) => {
  const simId = parseInt(req.params.id, 10);
  const answers = (req.body && req.body.answers) || {};

  const simQ = await query("SELECT * FROM questions WHERE sim_id=$1", [simId]);
  let correct = 0;
  const byArea = {}, byContent = {}, perQuestion = [];

  simQ.forEach((q) => {
    const isCorrect = String(answers[q.id] || "").trim() === String(q.answer).trim();
    if (isCorrect) correct++;
    perQuestion.push({
      id: q.id,
      area: q.area,
      content: q.content,
      chosen: answers[q.id] || null,
      correct: q.answer,
      hit: isCorrect
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
    pct: Math.round((s.correct / s.total) * 100)
  }));
  const contentArray = Object.entries(byContent).map(([content, s]) => ({
    content,
    total: s.total,
    correct: s.correct,
    pct: Math.round((s.correct / s.total) * 100)
  }));

  await query(
    "INSERT INTO attempts (id, user_id, simulado_id, date, score, total, correct, by_area, by_content, per_question) VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9)",
    [
      uuidv4(),
      req.user.id,
      simId,
      score,
      total,
      correct,
      JSON.stringify(areaArray),
      JSON.stringify(contentArray),
      JSON.stringify(perQuestion)
    ]
  );

  res.json({
    score,
    total,
    correct,
    byArea: areaArray,
    byContent: contentArray,
    perQuestion
  });
});

// histórico do aluno
app.get("/me/history", auth, async (req, res) => {
  const attempts = await query(
    "SELECT * FROM attempts WHERE user_id=$1 ORDER BY date DESC",
    [req.user.id]
  );
  res.json(attempts);
});

// ----------------- PROFESSOR / TURMA -----------------
function mustTeacher(req, res, next) {
  if (req.user.role !== "teacher")
    return res.status(403).json({ error: "teacher only" });
  next();
}

app.post("/classes", auth, mustTeacher, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const cls = { id: uuidv4(), name, teacherId: req.user.id };
  await query(
    "INSERT INTO classes (id, name, teacher_id) VALUES ($1,$2,$3)",
    [cls.id, cls.name, cls.teacherId]
  );
  res.json(cls);
});

app.get("/classes", auth, mustTeacher, async (req, res) => {
  const classes = await query("SELECT * FROM classes WHERE teacher_id=$1", [req.user.id]);
  res.json(classes);
});

app.post("/classes/:id/add-student", auth, mustTeacher, async (req, res) => {
  const { studentEmail } = req.body || {};
  if (!studentEmail) return res.status(400).json({ error: "studentEmail required" });

  const users = await query("SELECT * FROM users WHERE email=$1 AND role='student'", [studentEmail]);
  const student = users[0];
  if (!student) return res.status(404).json({ error: "student not found" });

  await query(
    "INSERT INTO class_students (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [req.params.id, student.id]
  );

  res.json({ ok: true });
});

app.get("/classes/:id/report", auth, mustTeacher, async (req, res) => {
  const simId = Number(req.query.simulado || 1);

  const cls = await query("SELECT * FROM classes WHERE id=$1 AND teacher_id=$2", [
    req.params.id,
    req.user.id
  ]);
  if (!cls.length) return res.status(404).json({ error: "class not found" });

  const studs = await query("SELECT student_id FROM class_students WHERE class_id=$1", [
    req.params.id
  ]);
  const studIds = studs.map((s) => s.student_id);

  if (!studIds.length) {
    return res.json({ class: cls[0], simuladoId: simId, average: 0, byArea: [], byContent: [], students: [] });
  }

  const attempts = await query(
    "SELECT * FROM attempts WHERE simulado_id=$1 AND user_id = ANY($2::uuid[])",
    [simId, studIds]
  );

  const avg = attempts.length
    ? attempts.reduce((s, a) => s + a.score, 0) / attempts.length
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
      pct: Math.round((v.correct / v.total) * 100 || 0)
    }));
  };

  const byArea = agg(attempts, "byArea");
  const byContent = agg(attempts, "byContent");
  const students = attempts.map((a) => ({
    student: a.user_id,
    score: Math.round(a.score)
  }));

  res.json({
    class: cls[0],
    simuladoId: simId,
    average: Math.round(avg),
    byArea,
    byContent,
    students
  });
});

// ----------------- START -----------------
(async () => {
  await runMigrations();
  app.listen(PORT, () =>
    console.log(`✔ Server rodando em http://localhost:${PORT}`)
  );
})();
