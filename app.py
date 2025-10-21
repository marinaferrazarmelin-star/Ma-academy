import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import fitz  # type: ignore
import pytesseract  # type: ignore
from flask import (Flask, jsonify, render_template, request, send_file,
                   url_for)
from markupsafe import Markup, escape
from pdf2image import convert_from_path  # type: ignore
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_FOLDER = BASE_DIR / "uploads"
STATIC_FOLDER = BASE_DIR / "static"
IMAGE_FOLDER = STATIC_FOLDER / "img"
DATA_FOLDER = BASE_DIR / "data"
QUESTION_BANK_PATH = DATA_FOLDER / "QuestionBank.json"

for folder in (UPLOAD_FOLDER, IMAGE_FOLDER, DATA_FOLDER):
    folder.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {"pdf"}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@dataclass
class Question:
    number: int
    raw_text: str
    pages: Sequence[int]
    exam_code: str
    texto: str = ""
    enunciado: str = ""
    alternativas: List[str] = field(default_factory=list)
    imagens: List[str] = field(default_factory=list)

    @property
    def question_id(self) -> str:
        return f"{self.exam_code}_Q{self.number:03d}"

    @property
    def materia(self) -> str:
        # Defaulting to English since the pipeline targets ENEM English questions.
        return "Inglês"

    @property
    def tema(self) -> str:
        return "Inglês"

    def to_dict(self) -> Dict[str, object]:
        return {
            "id": self.question_id,
            "matéria": self.materia,
            "tema": self.tema,
            "texto": self.texto,
            "enunciado": self.enunciado,
            "alternativas": self.alternativas,
            "imagens": self.imagens,
            "correta": None,
        }


def sanitize_exam_code(filename: str) -> str:
    stem = Path(filename).stem
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", stem).upper()
    if "F" not in cleaned:
        cleaned = f"{cleaned}_F1"
    return cleaned


def exam_image_directory(exam_code: str) -> Path:
    match = re.match(r"([A-Z]+)(\d{2})_F(\d+)", exam_code)
    if match:
        exam, year_suffix, phase = match.groups()
        year_full = int(year_suffix)
        if year_full < 30:
            year_full += 2000
        else:
            year_full += 1900
        slug = Path(exam.lower()) / f"{year_full}_f{phase}"
    else:
        slug = Path(exam_code.lower())
    directory = IMAGE_FOLDER / slug
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def relative_image_path(exam_code: str, filename: str) -> str:
    match = re.match(r"([A-Z]+)(\d{2})_F(\d+)", exam_code)
    if match:
        exam, year_suffix, phase = match.groups()
        year_full = int(year_suffix)
        if year_full < 30:
            year_full += 2000
        else:
            year_full += 1900
        slug = Path("img") / exam.lower() / f"{year_full}_f{phase}" / filename
    else:
        slug = Path("img") / exam_code.lower() / filename
    return str(slug).replace("\\", "/")


def clean_text_block(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        if re.match(r"^\d+\s*$", stripped):
            continue
        if re.search(r"ENEM\s+\d+", stripped, re.IGNORECASE):
            continue
        lines.append(stripped)
    # Remove leading/trailing blank lines and collapse multiples
    cleaned_lines: List[str] = []
    previous_blank = False
    for line in lines:
        if line == "":
            if not previous_blank:
                cleaned_lines.append("")
            previous_blank = True
        else:
            cleaned_lines.append(line)
            previous_blank = False
    return "\n".join(cleaned_lines).strip()


def parse_question_content(question: Question) -> None:
    text = clean_text_block(question.raw_text)
    if not text:
        return

    segments = [seg.strip() for seg in re.split(r"\n\s*\n", text) if seg.strip()]
    if len(segments) > 1:
        question.texto = segments[0]
        remaining = "\n\n".join(segments[1:])
    else:
        remaining = text

    alt_pattern = re.compile(r"([A-E])[\).]\s*(.*?)(?=(?:\n[A-E][\).]|\Z))", re.DOTALL)
    alternatives: List[str] = []
    first_alt_match = None
    for match in alt_pattern.finditer(remaining):
        if first_alt_match is None:
            first_alt_match = match
        label = match.group(1)
        body = clean_text_block(match.group(2))
        alternatives.append(f"{label}) {body}")
    question.alternativas = alternatives

    if first_alt_match is not None:
        enunciado_section = remaining[: first_alt_match.start()]
    else:
        enunciado_section = remaining
    question.enunciado = clean_text_block(enunciado_section)


def append_questionbank(questions: Sequence[Question]) -> None:
    existing: List[Dict[str, object]] = []
    if QUESTION_BANK_PATH.exists():
        try:
            existing = json.loads(QUESTION_BANK_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("Existing QuestionBank.json is corrupted. Resetting file.")
    existing_by_id = {item.get("id"): item for item in existing if isinstance(item, dict)}
    for question in questions:
        existing_by_id[question.question_id] = question.to_dict()
    QUESTION_BANK_PATH.write_text(
        json.dumps(list(existing_by_id.values()), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def map_offset_to_pages(pages: Sequence[Dict[str, int]], start: int, end: int) -> List[int]:
    matched_pages = []
    for info in pages:
        if info["end"] <= start:
            continue
        if info["start"] >= end:
            continue
        matched_pages.append(info["page"])
    return matched_pages


def collect_ocr_text(pdf_path: Path, pages: Sequence[int]) -> Dict[int, str]:
    if not pages:
        return {}
    try:
        first_page = min(pages) + 1
        last_page = max(pages) + 1
        pil_images = convert_from_path(pdf_path, dpi=200, first_page=first_page, last_page=last_page)
    except Exception as exc:  # noqa: BLE001 - surfacing OCR issues is important for debugging
        logger.warning("Failed to run pdf2image on %s: %s", pdf_path, exc)
        return {}
    ocr_results: Dict[int, str] = {}
    for offset, image in enumerate(pil_images):
        page_number = first_page + offset - 1
        page_index = page_number - 1
        if page_index not in pages:
            continue
        try:
            ocr_text = pytesseract.image_to_string(image, lang="por+eng")
            if ocr_text.strip():
                ocr_results[page_index] = clean_text_block(ocr_text)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed OCR on page %s: %s", page_number, exc)
    return ocr_results


def attach_images(doc: fitz.Document, question: Question, exam_dir: Path) -> None:
    image_counter = 1
    for page_number in question.pages:
        page = doc[page_number]
        for image_info in page.get_images(full=True):
            xref = image_info[0]
            try:
                pix = fitz.Pixmap(doc, xref)
                if pix.n >= 4:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                filename = f"{question.question_id.lower()}_{image_counter}.png"
                image_path = exam_dir / filename
                pix.save(image_path)
                rel_path = relative_image_path(question.exam_code, filename)
                question.imagens.append(rel_path)
                image_counter += 1
                logger.info("Saved image %s for question %s", rel_path, question.question_id)

                try:
                    ocr_text = pytesseract.image_to_string(str(image_path), lang="por+eng")
                    if ocr_text.strip():
                        if question.texto:
                            question.texto += "\n\n" + clean_text_block(ocr_text)
                        else:
                            question.texto = clean_text_block(ocr_text)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Image OCR failed for %s: %s", image_path, exc)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to extract image from page %s: %s", page_number + 1, exc)


def extract_questions(pdf_path: Path, exam_code: str) -> List[Question]:
    logger.info("Starting extraction for %s", pdf_path)
    doc = fitz.open(pdf_path)

    doc_text = ""
    page_infos: List[Dict[str, int]] = []
    for page_number, page in enumerate(doc):
        page_text = page.get_text("text")
        start_index = len(doc_text)
        doc_text += page_text + "\n"
        page_infos.append({"page": page_number, "start": start_index, "end": len(doc_text)})

    pattern = re.compile(r"QUEST[ÃA]O\s+(\d{1,3})", re.IGNORECASE)
    matches = list(pattern.finditer(doc_text))
    questions: List[Question] = []

    if not matches:
        logger.warning("No questions detected in %s", pdf_path)
        return questions

    for index, match in enumerate(matches):
        number = int(match.group(1))
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(doc_text)
        raw_text = doc_text[start:end].strip()
        pages = map_offset_to_pages(page_infos, match.start(), end)
        question = Question(number=number, raw_text=raw_text, pages=pages, exam_code=exam_code)
        questions.append(question)

    ocr_map = collect_ocr_text(pdf_path, sorted({p for q in questions for p in q.pages}))
    exam_dir = exam_image_directory(exam_code)

    for question in questions:
        parse_question_content(question)

        # Append OCR text from pages if needed
        for page in question.pages:
            ocr_text = ocr_map.get(page)
            if ocr_text and ocr_text not in question.raw_text:
                if question.enunciado:
                    question.enunciado += "\n\n" + ocr_text
                else:
                    question.enunciado = ocr_text

        # Ignore Spanish questions after English section
        if question.number > 5 and re.search(r"espanhol|español", question.raw_text, re.IGNORECASE):
            logger.info("Ignoring Spanish question %s", question.question_id)
            continue

        attach_images(doc, question, exam_dir)

        logger.info("Detected question %s", question.question_id)

    doc.close()

    filtered_questions = [q for q in questions if not (q.number > 5 and re.search(r"espanhol|español", q.raw_text, re.IGNORECASE))]
    return filtered_questions


app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = str(UPLOAD_FOLDER)


@app.template_filter("nl2br")
def nl2br_filter(value: Optional[str]) -> Markup:
    if not value:
        return Markup("")
    return Markup("<br />".join(escape(value).splitlines()))


@app.route("/")
def index() -> str:
    existing_questions: List[Dict[str, object]] = []
    if QUESTION_BANK_PATH.exists():
        try:
            existing_questions = json.loads(QUESTION_BANK_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("Could not read QuestionBank.json for preview.")
    return render_template("index.html", questions=existing_questions)


@app.route("/upload", methods=["POST"])
def upload() -> Tuple[str, int]:
    if "pdf" not in request.files:
        return jsonify({"error": "Nenhum arquivo PDF enviado."}), 400

    file = request.files["pdf"]
    if file.filename == "":
        return jsonify({"error": "Nenhum arquivo selecionado."}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "Formato de arquivo inválido."}), 400

    exam_name = request.form.get("exam_name") or sanitize_exam_code(file.filename)
    filename = secure_filename(file.filename)
    upload_path = UPLOAD_FOLDER / filename
    file.save(upload_path)

    exam_code = sanitize_exam_code(exam_name)

    questions = extract_questions(upload_path, exam_code)
    append_questionbank(questions)

    return (
        jsonify(
            {
                "message": f"Processamento concluído: {len(questions)} questões extraídas.",
                "questions": [question.to_dict() for question in questions],
                "downloadUrl": url_for("download_questionbank"),
            }
        ),
        200,
    )


@app.route("/questions")
def list_questions() -> Tuple[str, int]:
    if not QUESTION_BANK_PATH.exists():
        return jsonify([]), 200
    try:
        data = json.loads(QUESTION_BANK_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("Question bank file is not valid JSON.")
        data = []
    return jsonify(data), 200


@app.route("/download")
def download_questionbank():
    if not QUESTION_BANK_PATH.exists():
        QUESTION_BANK_PATH.write_text("[]", encoding="utf-8")
    return send_file(QUESTION_BANK_PATH, as_attachment=True, download_name="QuestionBank.json")


if __name__ == "__main__":
    app.run(debug=True)
