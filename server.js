// server.js (final: intent-aware + natural chat + library logic)
import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ===== path helpers =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Postgres setup =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Gemini setup =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== init tables =====
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      category TEXT,
      position TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
await initTables();

import("./seedBooks.js").catch(()=>{/* ignore if missing */});

// ===== helpers =====
function extractFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

const VALID_CATEGORIES = [
  "Công nghệ",
  "Văn học",
  "Lịch sử",
  "Kinh tế",
  "Tâm lý",
  "Giáo dục",
  "Chính trị",
  "Chưa rõ"
];

function normalizeCategory(input) {
  if (!input) return "Chưa rõ";
  input = input.trim().toLowerCase();
  for (const c of VALID_CATEGORIES) {
    if (c.toLowerCase() === input) return c;
  }
  if (/(tech|code|ai|data|lập trình|máy tính)/i.test(input)) return "Công nghệ";
  if (/(truyện|tiểu thuyết|văn học|novel|ký)/i.test(input)) return "Văn học";
  if (/(lịch sử|chiến tranh|history|war)/i.test(input)) return "Lịch sử";
  if (/(kinh tế|tài chính|business|economy)/i.test(input)) return "Kinh tế";
  if (/(tâm lý|psychology)/i.test(input)) return "Tâm lý";
  if (/(giáo dục|education)/i.test(input)) return "Giáo dục";
  if (/(chính trị|politic)/i.test(input)) return "Chính trị";
  return "Chưa rõ";
}

async function assignPosition(category) {
  const finalCategory = normalizeCategory(category);
  const letter = finalCategory[0].toUpperCase();
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category = $1", [finalCategory]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

async function inferCategory(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là thủ thư chuyên nghiệp. Dựa trên tên và tác giả, chọn thể loại phù hợp nhất từ danh sách sau:
${VALID_CATEGORIES.join(", ")}.

Trả về JSON duy nhất: {"category": "Tên thể loại chính xác trong danh sách"}.
Tên: "${bookName}"
Tác giả: "${author}"
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return normalizeCategory(parsed?.category);
  } catch (e) {
    console.error("⚠️ inferCategory error:", e);
    return "Chưa rõ";
  }
}

async function askGeminiToChoose(message, books, context = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là trợ lý thư viện. Dựa trên đoạn hội thoại gần đây:
${context}

Người dùng vừa nói: "${message}"

Danh sách sách: ${JSON.stringify(books, null, 2)}

Trả về JSON duy nhất:
{
 "title": "Tên sách EXACT từ DB",
 "author": "Tác giả EXACT từ DB",
 "category": "Thể loại EXACT từ DB",
 "location": "Vị trí EXACT từ DB",
 "reason": "Giải thích ngắn (1-2 câu)"
}
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    return extractFirstJson(raw);
  } catch (e) {
    console.error("⚠️ askGeminiToChoose error:", e);
    return null;
  }
}

async function askGeminiForRecap(bookTitle, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là trợ lý tóm tắt sách chuyên nghiệp.
Tóm tắt ngắn (100-200 từ) nội dung, chủ đề và đối tượng người đọc của cuốn:
- Tên: "${bookTitle}"
- Tác giả: "${author}"

Trả về JSON duy nhất:
{"title":"${bookTitle}", "author":"${author}", "recap":"Tóm tắt ngắn gọn không quá 200 từ"}
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    return extractFirstJson(raw);
  } catch (e) {
    console.error("⚠️ askGeminiForRecap error:", e);
    return null;
  }
}

async function chatWithGeminiFreeform(message, context = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là trợ lý AI thân thiện, thông minh, nói chuyện tự nhiên bằng tiếng Việt.
Bạn có thể sử dụng kiến thức hiện tại để trả lời chính xác, dễ hiểu.

Ngữ cảnh trước đó:
${context}

Người dùng: "${message}"

Hãy trả lời ngắn gọn, chính xác, dễ hiểu và thân thiện.
`;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    return (
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      result.response?.text() ||
      "⚠️ Không có phản hồi từ Gemini."
    );
  } catch (e) {
    console.error("⚠️ chatWithGeminiFreeform error:", e);
    return "⚠️ Xin lỗi, mình chưa thể phản hồi lúc này.";
  }
}

// ===== Intent Detection =====
async function detectIntent(message, context = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là bộ phân tích ngữ nghĩa của ứng dụng quản lý thư viện.

Phân loại câu sau thành một trong các loại sau:
- add_book
- delete_book
- ask_position
- ask_recap
- search_book
- smalltalk
- other

Trả về JSON duy nhất: {"intent": "<giá trị>"}

Ngữ cảnh gần đây:
${context}

Câu người dùng: "${message}"
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed?.intent || "other";
  } catch (e) {
    console.error("⚠️ detectIntent error:", e);
    return "other";
  }
}

// ===== Serve index.html =====
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ===== /chat endpoint =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["user", message]);

    const histRes = await pool.query("SELECT role, message FROM conversations ORDER BY id DESC LIMIT 6");
    const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");

    const intent = await detectIntent(message, recent);
    console.log("🧠 intent:", intent);

    let reply = "";
    const lower = message.toLowerCase();

    // === TÙY THEO INTENT ===
    if (intent === "add_book") {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên sách; at: Tác giả";
      else {
        const [_, bookName, author] = match;
        const category = await inferCategory(bookName, author);
        const position = await assignPosition(category);
        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName.trim(), author.trim(), category, position]
        );
        reply = `✅ Đã thêm sách: "${bookName.trim()}" (${author.trim()})\nThể loại: ${category}\nVị trí: ${position}`;
      }
    } else if (intent === "delete_book") {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên sách; at: Tác giả";
      else {
        const [_, bookName, author] = match;
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName.trim(), author.trim()]);
        reply = result.rowCount
          ? `🗑️ Đã xoá sách "${bookName}" của ${author}`
          : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      }
    } else if (intent === "ask_position") {
      const m = lower.match(/\bvị trí\s+([A-Z]\d+)\b/i);
      const pos = m ? m[1].toUpperCase() : null;
      if (!pos) reply = "⚠️ Hãy nhập vị trí theo dạng ví dụ: 'vị trí B2 là quyển gì'";
      else {
        const { rows } = await pool.query("SELECT name, author, category FROM books WHERE position=$1 LIMIT 1", [pos]);
        reply = rows.length
          ? `📚 Ở vị trí ${pos}: "${rows[0].name}" (${rows[0].author})\nThể loại: ${rows[0].category || "Chưa rõ"}`
          : `📭 Không có sách ở vị trí ${pos}.`;
      }
    } else if (intent === "ask_recap") {
      let guess = message.replace(/["'‘’“”]/g, "").toLowerCase();
      guess = guess.replace(/\b(recape?|tóm tắt|summary|giúp|cuốn|sách|hãy|nội dung|cho tôi|về|đi)\b/g, "").trim();
      const q = await pool.query(
        `SELECT name, author, category, position FROM books 
         WHERE LOWER(name) LIKE $1 OR LOWER(author) LIKE $1 LIMIT 1`,
        [`%${guess}%`]
      );
      const target = q.rows[0];
      if (!target) reply = "⚠️ Mình chưa rõ bạn muốn tóm tắt quyển nào. Hãy nói tên sách cụ thể nhé.";
      else {
        const recap = await askGeminiForRecap(target.name, target.author);
        reply = recap?.recap
          ? `📖 "${target.name}" (${target.author})\nThể loại: ${target.category}, Vị trí: ${target.position}\n\n📝 ${recap.recap}`
          : `⚠️ Không tóm tắt được lúc này.`;
      }
    } else if (intent === "search_book") {
      const { rows: books } = await pool.query("SELECT name, author, category, position FROM books");
      const keywords = lower;
      const matches = books.filter(b =>
        b.name.toLowerCase().includes(keywords) ||
        b.author.toLowerCase().includes(keywords) ||
        b.category.toLowerCase().includes(keywords)
      );
      if (matches.length) {
        const b = matches[0];
        reply = `📚 "${b.name}" (${b.author})\nThể loại: ${b.category}, Vị trí: ${b.position}`;
      } else reply = "⚠️ Không tìm thấy sách phù hợp.";
    } else {
      reply = await chatWithGeminiFreeform(message, recent);
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy trên cổng ${PORT}`));
