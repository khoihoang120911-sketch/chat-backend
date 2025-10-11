// server.js (v5: detect intent + recommend book + full context)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

import("./seedBooks.js").catch(() => {});

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
  "Chưa rõ",
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
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category=$1", [finalCategory]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

// ===== Gemini functions =====
async function detectIntent(message) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Phân loại câu sau thành một trong các loại sau:
- add_book
- delete_book
- ask_position
- ask_recap
- search_book
- recommend_book
- smalltalk
- other

Trả về JSON: {"intent": "tên loại"}
Câu: "${message}"
`;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed?.intent || "other";
  } catch (e) {
    console.error("⚠️ detectIntent error:", e);
    return "other";
  }
}

async function inferCategory(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là thủ thư. Dựa trên tên và tác giả, chọn thể loại từ danh sách sau:
${VALID_CATEGORIES.join(", ")}.

Trả về JSON: {"category": "Tên thể loại"}.
Tên: "${bookName}", Tác giả: "${author}"
`;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return normalizeCategory(parsed?.category);
  } catch (e) {
    console.error("⚠️ inferCategory error:", e);
    return "Chưa rõ";
  }
}

async function askGeminiForRecap(bookTitle, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Tóm tắt ngắn (100-200 từ) cho:
"${bookTitle}" của ${author}.
Trả về JSON: {"recap":"..."}
`;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed?.recap || null;
  } catch (e) {
    console.error("⚠️ askGeminiForRecap error:", e);
    return null;
  }
}

async function chatWithGeminiFreeform(message, context = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là trợ lý AI thân thiện nói tiếng Việt. Ngữ cảnh:
${context}

Người dùng: "${message}"
Trả lời ngắn gọn, tự nhiên, thân thiện.
`;
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    return (
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      result.response?.text() ||
      "⚠️ Không có phản hồi."
    );
  } catch (e) {
    console.error("⚠️ chatWithGeminiFreeform error:", e);
    return "⚠️ Xin lỗi, mình chưa thể trả lời lúc này.";
  }
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });

  try {
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["user", message]);

    const { rows: books } = await pool.query("SELECT * FROM books");
    const intent = await detectIntent(message);
    const histRes = await pool.query("SELECT role, message FROM conversations ORDER BY id DESC LIMIT 6");
    const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");

    let reply = "";

    if (intent === "add_book") {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên sách; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const category = await inferCategory(bookName, author);
        const position = await assignPosition(category);
        await pool.query("INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)", [bookName, author, category, position]);
        reply = `✅ Đã thêm "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      }
    } else if (intent === "delete_book") {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount ? `🗑️ Đã xoá "${bookName}" (${author})` : `⚠️ Không tìm thấy "${bookName}" (${author})`;
      }
    } else if (intent === "ask_recap") {
      const guess = message.replace(/["'‘’“”]/g, "").toLowerCase();
      const target = books.find(b => guess.includes(b.name.toLowerCase()) || guess.includes(b.author.toLowerCase()));
      if (!target) reply = "⚠️ Không rõ bạn muốn tóm tắt sách nào.";
      else {
        const recap = await askGeminiForRecap(target.name, target.author);
        reply = recap
          ? `📖 "${target.name}" (${target.author})\n📝 ${recap}`
          : "⚠️ Không thể tóm tắt ngay bây giờ.";
      
    } else if (intent === "recommend_book") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Người dùng nói: "${message}"
Bạn là thủ thư tâm lý, hãy gợi ý 1-3 cuốn trong thư viện phù hợp cảm xúc hoặc nhu cầu đó.
Nếu thư viện trống, gợi ý vài sách nổi tiếng ngoài thư viện.
`;
  const contextBooks = books.length
    ? books.map(b => `- ${b.name} (${b.author}) [${b.category}]`).join("\n")
    : "Thư viện hiện tại trống.";
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt + "\n\n" + contextBooks }] }],
  });
  reply =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    result.response?.text() ||
    "📚 Mình chưa nghĩ ra quyển nào phù hợp lúc này...";
}

    } else if (intent === "search_book") {
      const kw = message.toLowerCase();
      const found = books.filter(
        b =>
          b.name.toLowerCase().includes(kw) ||
          b.author.toLowerCase().includes(kw) ||
          b.category.toLowerCase().includes(kw)
      );
      if (found.length)
        reply = found
          .map(b => `📘 "${b.name}" (${b.author}) - ${b.category}, vị trí ${b.position}`)
          .join("\n");
      else reply = "⚠️ Không tìm thấy sách phù hợp.";
    } else {
      reply = await chatWithGeminiFreeform(message, recent);
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy trên cổng ${PORT}`));
