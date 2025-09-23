// Backend do GABARITA — Postgres + JWT
// Requer: DATABASE_URL e JWT_SECRET nas variáveis de ambiente (Render)

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

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL não definida. Configure no Render → Environment.");
  process.exit(1);
}

// Conexão Postgres (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Helpers DB ----------
async function query(q, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(q, params);
    return res;
  } finally {
    client.release();
  }
}

async function ensureTables() {
  // users
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('student','teacher')),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // questions (questões por simulado)
  await query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      sim_id INTEGER NOT NULL,
      area TEXT NOT NULL,
      content TEXT NOT NULL,
      text TEXT NOT NULL,
      options TEXT[] NOT NULL,
      answer TEXT NOT NULL
    );
  `);

  // attempts (histórico de tentativas)
  await query(`
    CREATE TABLE IF NOT EXISTS attempts (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      simulado_id INTEGER NOT NULL,
      date TIMESTAMP NOT NULL DEFAULT NOW(),
      score NUMERIC NOT NULL,
      total INTEGER NOT NULL,
      correct INTEGER NOT NULL,
      by_area JSONB NOT NULL,
      by_content JSONB NOT NULL,
      per_question JSONB NOT NULL
    );
  `);

  // classes (turmas)
  await query(`
    CREATE TABLE IF NOT EXISTS classes (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // relação turma-alunos
  await query(`
    CREATE TABLE IF NOT EXISTS class_students (
      class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (class_id, student_id)
    );
  `);

  // índices úteis
  await query(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_attempts_sim ON attempts(simulado_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_questions_sim ON questions(sim_id);`);

  // se não houver questões, insere um simulado básico (10 questões)
  const { rows: existing } = await query(`SELECT COUNT(*)::int AS c FROM questions;`);
  if (existing[0].c === 0) {
    const areas = ['Física','Matemática','História','Português'];
    const contents = ['Cinemática','Funções','Brasil Império','Interpretação de texto'];
    const opts = ['A','B','C','D','E'];
    const batch = [];
    for (let i=1;i<=10;i++){
      batch.push(query(
        `INSERT INTO questions (sim_id, area, content, text, options, answer)
         VALUES ($1,$2,$3,$4,$5,$6);`,
        [1, areas[(i-1)%4], contents[(i-1)%4], `Pergunta de exemplo ${i}?`, opts, opts[(i-1)%5]]
      ));
    }
    await Promise.all(batch);
    console.log("✔ Simulado inicial (1) inserido com 10 questões");
  }
}

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

// ---------- AUTH ----------
app.post("/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "name, email, password, role required" });
  if (!["student", "teacher"].includes(role))
    return res.status(400).json({ error: "role must be student or teacher" });

  const { rows: exist } = await query(`SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)`, [email]);
  if (exist.length) return res.status(409).json({ error: "email already registered" });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  await query(
    `INSERT INTO users (id, name, email, role, password_hash) VALUES ($1,$2,$3,$4,$5)`,
    [id, name, email, role, hash]
  );
  const user = { id, name, email, role };
  return res.json({ token: signToken(user), user });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`, [email || ""]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    return res.status(401).json({ error: "invalid credentials" });
  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

app.get("/me", auth, async (req, res) => {
  const { rows } = await query(`SELECT id,name,email,role FROM users WHERE id=$1`, [req.user.id]);
  res.json(rows[0]);
});

// ---------- SIMULADOS ----------
app.get("/simulados", auth, async (req, res) => {
  const { rows } = await query(`
    SELECT sim_id AS id, COUNT(*)::int AS total
    FROM questions
    GROUP BY sim_id
    ORDER BY sim_id ASC
  `);
  const list = rows.map(r => ({
    id: Number(r.id),
    name: r.id === 1 ? "ENEM 2024 – Dia 1" : `Simulado ${r.id}`,
    total: r.total
  }));
  res.json(list);
});

app.get("/simulado/:id", auth, async (req, res) => {
  const simId = Number(req.params.id);
  const { rows } = await query(
    `SELECT id, area, content, text, options FROM questions WHERE sim_id=$1 ORDER BY id ASC`,
    [simId]
  );
  res.json(rows);
});

app.post("/simulado/:id/submit", auth, async (req, res) => {
  const simId = Number(req.params.id);
  const answers = (req.body && req.body.answers) || {};

  const { rows: simQ } = await query(
    `SELECT id, area, content, text, options, answer FROM questions WHERE sim_id=$1 ORDER BY id ASC`,
    [simId]
  );
  let correct = 0;
  const byArea = {}, byContent = {}, perQuestion = [];

  simQ.forEach(q => {
    const chosen = String(answers[q.id] || "").trim();
    const isCorrect = chosen === String(q.answer).trim();
    if (isCorrect) correct++;
    perQuestion.push({
      id: q.id, area: q.area, content: q.content,
      chosen: chosen || null, correct: q.answer, hit: isCorrect
    });
    if (!byArea[q.area]) byArea[q.area] = { total: 0, correct: 0 };
    if (!byContent[q.content]) byContent[q.content] = { total: 0, correct: 0 };
    byArea[q.area].total++; byContent[q.content].total++;
    if (isCorrect) { byArea[q.area].correct++; byContent[q.content].correct++; }
  });

  const total = simQ.length || 1;
  const score = (correct / total) * 100;

  const areaArray = Object.entries(byArea).map(([area, s]) => ({
    area, total: s.total, correct: s.correct, pct: Math.round((s.correct / s.total) * 100),
  }));
  const contentArray = Object.entries(byContent).map(([content, s]) => ({
    content, total: s.total, correct: s.correct, pct: Math.round((s.correct / s.total) * 100),
  }));

  await query(
    `INSERT INTO attempts (id, user_id, simulado_id, score, total, correct, by_area, by_content, per_question)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidv4(), req.user.id, simId, score, total, correct, areaArray, contentArray, perQuestion]
  );

  res.json({
    score, total, correct,
    byArea: areaArray, byContent: contentArray, perQuestion
  });
});

// histórico — aluno próprio ou (se professor) de um aluno específico via ?userId=...
app.get("/me/history", auth, async (req, res) => {
  let targetUser = req.user.id;
  const userIdParam = (req.query.userId || "").trim();
  if (userIdParam && req.user.role === "teacher") {
    targetUser = userIdParam; // professor pode consultar aluno
  }
  const { rows } = await query(
    `SELECT id, user_id AS "userId", simulado_id AS "simuladoId", date, score, total, correct
     FROM attempts
     WHERE user_id=$1
     ORDER BY date DESC`,
    [targetUser]
  );
  res.json(rows);
});

// ---------- CLASSES (PROFESSOR) ----------
app.post("/classes", auth, mustTeacher, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = uuidv4();
  await query(`INSERT INTO classes (id,name,teacher_id) VALUES ($1,$2,$3)`, [id, name, req.user.id]);
  res.json({ id, name, teacherId: req.user.id });
});

app.get("/classes", auth, mustTeacher, async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, teacher_id AS "teacherId" FROM classes WHERE teacher_id=$1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

app.get("/classes/:id", auth, mustTeacher, async (req, res) => {
  const classId = req.params.id;
  // valida se turma é do professor
  const { rows: klass } = await query(
    `SELECT id, name FROM classes WHERE id=$1 AND teacher_id=$2`,
    [classId, req.user.id]
  );
  if (!klass.length) return res.status(404).json({ error: "class not found" });

  const { rows: studs } = await query(
    `SELECT u.id, u.name, u.email
     FROM class_students cs
     JOIN users u ON u.id = cs.student_id
     WHERE cs.class_id=$1
     ORDER BY u.name ASC`,
    [classId]
  );
  res.json({ id: classId, name: klass[0].name, students: studs });
});

app.post("/classes/:id/add-student", auth, mustTeacher, async (req, res) => {
  const classId = req.params.id;
  const { studentEmail } = req.body || {};
  if (!studentEmail) return res.status(400).json({ error: "studentEmail required" });

  // valida turma do professor
  const { rows: klass } = await query(
    `SELECT id FROM classes WHERE id=$1 AND teacher_id=$2`,
    [classId, req.user.id]
  );
  if (!klass.length) return res.status(404).json({ error: "class not found" });

  // encontra aluno
  const { rows: stu } = await query(
    `SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role='student'`,
    [studentEmail]
  );
  if (!stu.length) return res.status(404).json({ error: "student not found" });
  const studentId = stu[0].id;

  // adiciona relação (idempotente)
  await query(
    `INSERT INTO class_students (class_id, student_id)
     VALUES ($1,$2)
     ON CONFLICT (class_id, student_id) DO NOTHING`,
    [classId, studentId]
  );

  res.json({ ok: true, classId, studentId });
});

// relatório da turma
app.get("/classes/:id/report", auth, mustTeacher, async (req, res) => {
  const classId = req.params.id;
  const simId = Number(req.query.simulado || 1);

  // valida turma do professor
  const { rows: klass } = await query(
    `SELECT id, name FROM classes WHERE id=$1 AND teacher_id=$2`,
    [classId, req.user.id]
  );
  if (!klass.length) return res.status(404).json({ error: "class not found" });

  // alunos da turma
  const { rows: studs } = await query(
    `SELECT u.id, u.name FROM class_students cs JOIN users u ON u.id=cs.student_id WHERE cs.class_id=$1`,
    [classId]
  );
  const studentIds = studs.map(s => s.id);
  if (!studentIds.length) {
    return res.json({
      class: { id: classId, name: klass[0].name },
      simuladoId: simId, average: 0, byArea: [], byContent: [], students: []
    });
  }

  // tentativas desses alunos no simulado informado
  const { rows: attempts } = await query(
    `SELECT user_id AS "userId", score, total, correct, by_area AS "byArea", by_content AS "byContent"
     FROM attempts
     WHERE simulado_id=$1 AND user_id = ANY($2::uuid[])`,
    [simId, studentIds]
  );

  const avg = attempts.length ? Math.round(attempts.reduce((s,a)=>s+Number(a.score),0)/attempts.length) : 0;

  // agrega por área/conteúdo
  const aggMap = (arr, key) => {
    const map = {};
    arr.forEach(a => (a[key] || []).forEach(x => {
      const k = key === "byArea" ? x.area : x.content;
      if (!map[k]) map[k] = { total: 0, correct: 0 };
      map[k].total += Number(x.total);
      map[k].correct += Number(x.correct);
    }));
    return Object.entries(map).map(([k, v]) => ({
      [key === "byArea" ? "area" : "content"]: k,
      total: v.total,
      correct: v.correct,
      pct: Math.round((v.correct / Math.max(1,v.total)) * 100)
    }));
  };

  const byArea = aggMap(attempts, "byArea");
  const byContent = aggMap(attempts, "byContent");
  const students = attempts.map(a => ({
    student: (studs.find(s=>s.id===a.userId)?.name) || "Aluno",
    score: Math.round(Number(a.score))
  }));

  res.json({
    class: { id: classId, name: klass[0].name },
    simuladoId: simId,
    average: avg,
    byArea,
    byContent,
    students
  });
});

// ---------- START ----------
ensureTables().then(() => {
  app.listen(PORT, () => console.log(`✔ Server on http://0.0.0.0:${PORT}`));
}).catch(err => {
  console.error("Erro ao inicializar tabelas:", err);
  process.exit(1);
});
