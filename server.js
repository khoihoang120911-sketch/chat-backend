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

// ===== PostgreSQL setup =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Gemini setup =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== Tạo bảng nếu chưa có =====
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

// ===== Seed dữ liệu nếu DB rỗng =====
import("./seedBooks.js");

// ===== Helper: suy luận thể loại + vị trí từ Gemini =====
async function inferCategoryAndPosition(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là quản thủ thư viện. 
Nhiệm vụ: Suy luận thể loại & vị trí kệ sách cho cuốn:
- Tên: "${bookName}"
- Tác giả: "${author}"

Trả về JSON:
{"category": "...", "position": "..."}
`;

  const response = await model.generateContent(prompt);
  try {
    return JSON.parse(response.response.text());
  } catch {
    return { category: "Chưa rõ", position: "?" };
  }
}

// ===== Serve index.html =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== API Chat =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    // Lưu user message
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["user", message]);

    let reply = "";

    // ===== Add book =====
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (match) {
        const bookName = match[1].trim();
        const author = match[2].trim();

        const { category, position } = await inferCategoryAndPosition(bookName, author);

        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName, author, category, position]
        );

        reply = `✅ Đã thêm sách: "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      } else {
        reply = "❌ Sai cú pháp. Hãy dùng: `add book: bn: Tên sách; at: Tác giả`";
      }
    }

    // ===== Delete book =====
    else if (message.toLowerCase().startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (match) {
        const bookName = match[1].trim();
        const author = match[2].trim();

        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        if (result.rowCount > 0) {
          reply = `🗑️ Đã xoá sách "${bookName}" của ${author}`;
        } else {
          reply = `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
        }
      } else {
        reply = "❌ Sai cú pháp. Hãy dùng: `delete book: bn: Tên sách; at: Tác giả`";
      }
    }

    // ===== Gợi ý sách =====
    else {
      const result = await pool.query("SELECT name, author, category, position FROM books");
      const books = result.rows;

      if (books.length === 0) {
        reply = "📭 Thư viện hiện chưa có sách.";
      } else {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
Người dùng vừa nói: "${message}".
Đây là danh sách sách trong thư viện: ${JSON.stringify(books, null, 2)}.

Nhiệm vụ:
1. Chọn 1 cuốn sách phù hợp nhất.
2. Trả về JSON:
{
  "title": "Tên sách",
  "author": "Tác giả",
  "category": "Thể loại",
  "location": "Vị trí",
  "reason": "Tại sao cuốn này phù hợp với người dùng"
}
⚠️ category và location phải lấy từ DB, không bịa thêm.
`;

        const response = await model.generateContent(prompt);
        const raw = response.response.text();

        try {
          const book = JSON.parse(raw);
          reply = `📚 Gợi ý cho bạn: "${book.title}" (Tác giả: ${book.author})\nThể loại: ${book.category}, Vị trí: ${book.location}\n💡 Lý do: ${book.reason}`;
        } catch {
          reply = "🤔 Tôi chưa tìm ra cuốn nào phù hợp.";
        }
      }
    }

    // Lưu assistant reply
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy trên cổng ${PORT}`);
});
