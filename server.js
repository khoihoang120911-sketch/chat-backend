// server.js (final + giữ nguyên toàn bộ logic + thêm chat tự nhiên với Gemini)
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

// ===== Đường dẫn hiện tại =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Cấu hình Postgres =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Cấu hình Gemini =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== Khởi tạo bảng =====
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

// ===== Seed data (nếu có) =====
import("./seedBooks.js").catch(() => {
  // ignore nếu file seedBooks.js không tồn tại
});

// ===== Helpers =====

// Hàm trích xuất JSON đầu tiên từ text
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

// Hàm tự động gán vị trí cho sách theo thể loại
async function assignPosition(category) {
  if (!category) return "X?";
  const letter = category.trim()[0]?.toUpperCase() || "X";
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category = $1", [category]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

// Hàm xác định thể loại bằng Gemini
async function inferCategory(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là quản thủ thư viện thông minh.
Dựa trên tên sách và tác giả, xác định thể loại phù hợp nhất:
- Tên: "${bookName}"
- Tác giả: "${author}"
Trả về JSON: {"category":"..."} duy nhất.
  `;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    const parsed = extractFirstJson(raw);
    if (parsed && parsed.category) return parsed.category;
    return "Chưa rõ";
  } catch {
    return "Chưa rõ";
  }
}

// Hàm chọn sách phù hợp với câu hỏi người dùng
async function askGeminiToChoose(message, books, conversationContext = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Người dùng vừa nói: "${message}"
Danh sách sách: ${JSON.stringify(books, null, 2)}
Chọn 1 cuốn phù hợp, trả về JSON duy nhất:
{"title":"","author":"","category":"","location":"","reason":""}
  `;
  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch {
    return null;
  }
}

// Hàm tóm tắt nội dung sách
async function askGeminiForRecap(bookTitle, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Tóm tắt ngắn gọn (100-200 từ) về:
- Tên: "${bookTitle}"
- Tác giả: "${author}"
Trả về JSON duy nhất:
{"title":"${bookTitle}","author":"${author}","recap":"..."}
  `;
  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch {
    return null;
  }
}

// ===== Gửi file index.html =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== Endpoint chat chính =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["user", message]);
    let reply = "";
    const lower = message.toLowerCase();

    // === Thêm sách ===
    if (lower.startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên sách; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const category = await inferCategory(bookName, author);
        const position = await assignPosition(category);
        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName, author, category, position]
        );
        reply = `✅ Đã thêm sách: "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      }
    }

    // === Xóa sách ===
    else if (lower.startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên sách; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount
          ? `🗑️ Đã xoá sách "${bookName}" của ${author}`
          : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      }
    }

    // === Truy vấn vị trí ===
    else if (/\bvị trí\s+[A-Z]\d+\b/i.test(lower)) {
      const m = lower.match(/\bvị trí\s+([A-Z]\d+)\b/i);
      const pos = m ? m[1].toUpperCase() : null;
      if (!pos) reply = "⚠️ Hãy nhập vị trí theo dạng 'vị trí B2 là quyển gì'";
      else {
        const { rows } = await pool.query("SELECT name, author, category FROM books WHERE position=$1 LIMIT 1", [pos]);
        reply = rows.length
          ? `📚 Ở vị trí ${pos}: "${rows[0].name}" (${rows[0].author})\nThể loại: ${rows[0].category}`
          : `📭 Không có sách ở vị trí ${pos}.`;
      }
    }

    // === Tóm tắt (Recap) ===
    else if (/\b(tóm tắt|recap|summary|tóm tắt giúp|tóm tắt nội dung)\b/i.test(lower)) {
      let target = null;
      const guess = message.replace(/["'‘’“”]/g, "").trim();
      const q = await pool.query(
        `SELECT name, author, category, position FROM books 
         WHERE LOWER(name) LIKE $1 OR LOWER(author) LIKE $1 LIMIT 1`,
        [`%${guess.toLowerCase()}%`]
      );
      if (q.rows.length) target = q.rows[0];
      if (!target) reply = "⚠️ Hãy nói rõ tên sách cần tóm tắt.";
      else {
        const recap = await askGeminiForRecap(target.name, target.author);
        reply = recap?.recap
          ? `📖 "${target.name}" (${target.author})\n📝 ${recap.recap}`
          : `⚠️ Không thể tóm tắt ngay bây giờ.`;
      }
    }

    // === Tìm kiếm và gợi ý ===
    else {
      const { rows: books } = await pool.query("SELECT name, author, category, position FROM books");
      if (!books.length) reply = "📭 Thư viện trống.";
      else {
        const histRes = await pool.query("SELECT role, message FROM conversations ORDER BY id DESC LIMIT 6");
        const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");
        const keywords = message.toLowerCase();
        const directMatch = books.filter(b =>
          (b.name && b.name.toLowerCase().includes(keywords)) ||
          (b.author && b.author.toLowerCase().includes(keywords)) ||
          (b.category && b.category.toLowerCase().includes(keywords))
        );
        let chosen = null;
        if (directMatch.length === 1) {
          chosen = directMatch[0];
          reply = `📚 "${chosen.name}" (${chosen.author})\nThể loại: ${chosen.category}, Vị trí: ${chosen.position}`;
        } else {
          const poolForChoice = directMatch.length ? directMatch : books;
          const pick = await askGeminiToChoose(message, poolForChoice, recent);
          const rec = pick && poolForChoice.find(b => b.name === pick.title) || poolForChoice[0];
          reply = `📚 Gợi ý: "${rec.name}" (${rec.author})\nThể loại: ${rec.category}, Vị trí: ${rec.position}\n💡 ${pick?.reason || "Phù hợp với yêu cầu."}`;
        }
      }
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Chat tự nhiên với Gemini =====
app.post("/gemini-chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const response = await model.generateContent(message);
    const text = response.response.text();
    res.json({ reply: text });
  } catch (e) {
    console.error("⚠️ Gemini chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== Khởi động server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy trên cổng ${PORT}`));
