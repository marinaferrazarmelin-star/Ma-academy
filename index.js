// Backend do GABARITA — versão com PostgreSQL
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
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

// Conexão PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Cria tabelas se não existirem
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT CHECK (role IN ('student','teacher')) NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attempts (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      simulado_id TEXT NOT NULL,
      date TIMESTAMP NOT NULL,
      score INT NOT NULL,
      total INT NOT NULL,
      correct INT NOT NULL,
      data JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id UUID REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS class_students (
      class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (class_id, student_id)
    );
  `);
  console.log("✔ Tabelas ok");
}
ensureTables().catch(console.error);

// Funções auxiliares
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
function mustTeacher(req, res, next) {
  if (req.user.role !== "teacher")
    return res.status(403).json({ error: "teacher only" });
  next();
}

// ---------------- AUTH ----------------

// Registro
app.post("/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "name, email, password, role required" });
  if (!["student", "teacher"].includes(role))
    return res.status(400).json({ error: "role must be student or teacher" });

  try {
    const hash = bcrypt.hashSync(password, 12);
    const user = { id: uuidv4(), name, email, role, password_hash: hash };

    await pool.query(
      "INSERT INTO users (id,name,email,role,password_hash) VALUES ($1,$2,$3,$4,$5)",
      [user.id, user.name, user.email.toLowerCase(), user.role, user.password_hash]
    );

    return res.json({
      token: signToken(user),
      user: { id: user.id, name, email: user.email, role: user.role }
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email already registered" });
    }
    console.error(err);
    return res.status(500).json({ error: "server error" });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server error" });
  }
});

// Perfil
app.get("/me", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,name,email,role FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// ---------------- SIMULADOS ----------------

// Questões: aqui você pode deixar ainda no arquivo JSON (mock)
const fs = require("fs");
const DATA_DIR = path.join(__dirname, "data");
const QUESTIONS_PATH = path.join(DATA_DIR, "questions.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(QUESTIONS_PATH)) fs.writeFileSync(QUESTIONS_PATH, JSON.stringify({ "1": [] }, null, 2));
let QUESTIONS = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));

app.get("/simulados", auth, (req, res) => {
  const list = Object.keys(QUESTIONS).map((k) => ({
    id: Number(k),
    name: k === "1" ? "ENEM 2024 – Dia 1" : `Simulado ${k}`,
    total: (QUESTIONS[k] || []).length
  }));
  res.json(list);
});

app.get("/simulado/:id", auth, (req, res) => {
  const sim = QUESTIONS[req.params.id] || [];
  const safe = sim.map(({ id, area, content, text, options }) => ({
    id, area, content, text, options
  }));
  res.json(safe);
});

app.post("/simulado/:id/submit", auth, async (req, res) => {
  const simId = String(req.params.id);
  const answers = (req.body && req.body.answers) || {};
  const simQ = QUESTIONS[simId] || [];

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
  const score = Math.round((correct / total) * 100);

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

  try {
    await pool.query(
      "INSERT INTO attempts (id,user_id,simulado_id,date,score,total,correct,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [uuidv4(), req.user.id, simId, new Date(), score, total, correct,
        JSON.stringify({ byArea: areaArray, byContent: contentArray, perQuestion })]
    );
  } catch (err) {
    console.error(err);
  }

  res.json({ score, total, correct, byArea: areaArray, byContent: contentArray, perQuestion });
});

// Histórico do aluno
app.get("/me/history", auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,simulado_id,date,score,total,correct,data FROM attempts WHERE user_id=$1 ORDER BY date DESC",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// ---------------- PROFESSOR / CLASSES ----------------

app.post("/classes", auth, mustTeacher, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = uuidv4();
  try {
    await pool.query(
      "INSERT INTO classes (id,name,teacher_id) VALUES ($1,$2,$3)",
      [id, name, req.user.id]
    );
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

app.get("/classes", auth, mustTeacher, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM classes WHERE teacher_id=$1", [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

app.post("/classes/:id/add-student", auth, mustTeacher, async (req, res) => {
  const { studentEmail } = req.body || {};
  if (!studentEmail) return res.status(400).json({ error: "studentEmail required" });
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE email=$1 AND role='student'", [studentEmail.toLowerCase()]);
    const student = rows[0];
    if (!student) return res.status(404).json({ error: "student not found" });

    await pool.query(
      "INSERT INTO class_students (class_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [req.params.id, student.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

app.get("/classes/:id/report", auth, mustTeacher, async (req, res) => {
  const simId = String(req.query.simulado || 1);
  try {
    const clsRes = await pool.query("SELECT * FROM classes WHERE id=$1 AND teacher_id=$2", [req.params.id, req.user.id]);
    const cls = clsRes.rows[0];
    if (!cls) return res.status(404).json({ error: "class not found" });

    const studentsRes = await pool.query(
      "SELECT student_id FROM class_students WHERE class_id=$1", [req.params.id]
    );
    const studs = studentsRes.rows.map(r => r.student_id);
    if (!studs.length) return res.json({ class: cls, simuladoId: simId, average: 0, byArea: [], byContent: [], students: [] });

    const attemptsRes = await pool.query(
      "SELECT * FROM attempts WHERE simulado_id=$1 AND user_id = ANY($2::uuid[])",
      [simId, studs]
    );
    const attempts = attemptsRes.rows;

    const avg = attempts.length ? attempts.reduce((s,a)=>s+a.score,0)/attempts.length : 0;

    const agg = (arr, key) => {
      const map = {};
      arr.forEach(a=>{
        const arrData = (a.data?.[key]) || [];
        arrData.forEach(x=>{
          const k = key === "byArea" ? x.area : x.content;
          if (!map[k]) map[k] = { total:0, correct:0 };
          map[k].total += x.total;
          map[k].correct += x.correct;
        });
      });
      return Object.entries(map).map(([k,v])=>({
        [key==="byArea"?"area":"content"]:k,
        total:v.total,
        correct:v.correct,
        pct: Math.round((v.correct/v.total)*100 || 0)
      }));
    };

    const byArea = agg(attempts,"byArea");
    const byContent = agg(attempts,"byContent");
    const students = attempts.map(a=>({
      student:a.user_id,
      score:Math.round(a.score)
    }));

    res.json({ class:cls, simuladoId:simId, average:Math.round(avg), byArea, byContent, students });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`✔ Server on http://localhost:${PORT}`);
});
