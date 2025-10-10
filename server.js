// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Postgres pool (Render: cần ssl rejectUnauthorized:false)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Gemini client (API key in env)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ensure table exists
const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      ten_sach TEXT NOT NULL,
      tac_gia TEXT NOT NULL,
      the_loai TEXT,
      vi_tri TEXT,
      tom_tat TEXT
    );
  `);
};
await ensureTable().catch(err => {
  console.error("Cannot ensure books table:", err);
  process.exit(1);
});

// Helper: determine base shelf for a genre from DB (or fallback map)
const fallbackGenreBase = {
  "Văn học": "B1",
  "Lịch sử": "C1",
  "Khoa học": "D1",
  "Tâm lý": "E1",
  "Thiếu nhi": "F1",
  "Khác": "X1"
};

async function getBaseShelfForGenre(genre) {
  const r = await pool.query("SELECT vi_tri FROM books WHERE the_loai=$1 AND vi_tri IS NOT NULL LIMIT 1", [genre]);
  if (r.rows.length && r.rows[0].vi_tri) return r.rows[0].vi_tri;
  return fallbackGenreBase[genre] || "X1";
}

async function countBooksInShelf(shelf) {
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE vi_tri=$1", [shelf]);
  return parseInt(res.rows[0].count, 10);
}

function parseShelf(baseShelf) {
  const m = String(baseShelf).match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return { prefix: String(baseShelf).replace(/\d+$/, ""), start: 1 };
  return { prefix: m[1].toUpperCase(), start: parseInt(m[2], 10) };
}

async function assignShelf(genre) {
  const base = await getBaseShelfForGenre(genre);
  const { prefix, start } = parseShelf(base);
  let n = start;
  while (true) {
    const shelf = `${prefix}${n}`;
    const cnt = await countBooksInShelf(shelf);
    if (cnt < 15) return shelf;
    n++;
  }
}

// Use Gemini to infer genre (string) and short summary
async function inferGenreAndSummary(title, author) {
  const prompt = `
Dựa trên thông tin:
Tên sách: "${title}"
Tác giả: "${author}"

Hãy trả về JSON duy nhất:
{ "the_loai": "<một trong: Văn học, Lịch sử, Khoa học, Tâm lý, Thiếu nhi, Khác>", "tom_tat": "<tóm tắt 1-2 câu>" }

Chỉ trả JSON, không giải thích.
`;
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });
    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = JSON.parse(text.trim());
    return {
      the_loai: parsed.the_loai || "Khác",
      tom_tat: parsed.tom_tat || "Chưa có"
    };
  } catch (e) {
    console.warn("AI infer failed, fallback:", e?.message || e);
    return { the_loai: "Khác", tom_tat: "Chưa có" };
  }
}

// POST /chat - handles add/delete/find commands (body: { message })
app.post("/chat", async (req, res) => {
  const message = (req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Thiếu message" });

  try {
    // ADD
    if (message.toLowerCase().startsWith("add book")) {
      const m = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!m) return res.json({ reply: "Sai cú pháp: add book: bn: Tên; at: Tác giả" });
      const title = m[1].trim();
      const author = m[2].trim();

      // use Gemini to infer genre + summary
      const info = await inferGenreAndSummary(title, author);
      const shelf = await assignShelf(info.the_loai);

      const insert = await pool.query(
        "INSERT INTO books (ten_sach, tac_gia, the_loai, vi_tri, tom_tat) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [title, author, info.the_loai, shelf, info.tom_tat]
      );
      return res.json({ reply: `✅ Đã thêm sách:\n${JSON.stringify(insert.rows[0], null, 2)}` });
    }

    // DELETE
    if (message.toLowerCase().startsWith("delete book")) {
      const m = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!m) return res.json({ reply: "Sai cú pháp: delete book: bn: Tên; at: Tác giả" });
      const title = m[1].trim();
      const author = m[2].trim();

      const del = await pool.query("DELETE FROM books WHERE ten_sach=$1 AND tac_gia=$2 RETURNING *", [title, author]);
      if (del.rows.length === 0) return res.json({ reply: `❌ Không tìm thấy sách "${title}" của ${author}` });
      return res.json({ reply: `🗑️ Đã xóa:\n${JSON.stringify(del.rows[0], null, 2)}` });
    }

    // FIND (simple DB lookup first)
    const find = await pool.query(
      `SELECT * FROM books
       WHERE ten_sach ILIKE $1 OR the_loai ILIKE $1 OR tac_gia ILIKE $1 OR tom_tat ILIKE $1
       LIMIT 1`,
      [`%${message}%`]
    );
    if (find.rows.length > 0) {
      const b = find.rows[0];
      const reply = `📚 Gợi ý:\nTên: ${b.ten_sach}\nTác giả: ${b.tac_gia}\nThể loại: ${b.the_loai}\nVị trí: ${b.vi_tri}\nRecap: ${b.tom_tat}`;
      return res.json({ reply });
    }

    // Nếu DB không tìm -> hỏi Gemini (có thể pass DB list if needed)
    const prompt = `Người dùng: "${message}"
Bạn hãy gợi ý 1 quyển sách phù hợp dựa trên thông tin hiện có. Nếu không có, trả "Không tìm thấy sách phù hợp".`;
    const gresp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
    const text = gresp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "Không có phản hồi.";
    return res.json({ reply: text.replace(/\n/g, "<br>") });

  } catch (err) {
    console.error("server error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Serve static if you have index.html
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
