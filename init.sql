-- Usuários
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT CHECK (role IN ('student','teacher')) NOT NULL,
  password_hash TEXT NOT NULL
);

-- Questões
CREATE TABLE IF NOT EXISTS questions (
  sim_id INT NOT NULL,
  id SERIAL PRIMARY KEY,
  area TEXT NOT NULL,
  content TEXT NOT NULL,
  text TEXT NOT NULL,
  options JSONB NOT NULL,
  answer TEXT NOT NULL
);

-- Tentativas (histórico)
CREATE TABLE IF NOT EXISTS attempts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  simulado_id INT NOT NULL,
  date TIMESTAMP NOT NULL DEFAULT NOW(),
  score NUMERIC,
  total INT,
  correct INT,
  by_area JSONB,
  by_content JSONB,
  per_question JSONB
);

-- Turmas
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  teacher_id UUID REFERENCES users(id)
);

-- Relacionamento turma-aluno
CREATE TABLE IF NOT EXISTS class_students (
  class_id UUID REFERENCES classes(id),
  student_id UUID REFERENCES users(id),
  PRIMARY KEY (class_id, student_id)
);
