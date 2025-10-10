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
initTables();

// ===== Helper: suy luận thể loại + vị trí từ Gemini =====
async function inferCategoryAndPosition(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = `
  Bạn là quản thủ thư viện.
  Với sách "${bookName}" của tác giả "${author}", hãy đoán:
  - Thể loại (ví dụ: Văn học, Lịch sử, Khoa học, Tâm lý,...)
  - Vị trí: ký tự đầu = chữ cái viết tắt thể loại, số = kệ (mỗi kệ chứa tối đa 15 quyển).

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

    // ===== Tìm sách trong DB bằng Gemini =====
    else {
      // Lấy toàn bộ sách trong DB
      const result = await pool.query("SELECT name, author, category, position FROM books");
      const books = result.rows;

      if (books.length === 0) {
        reply = "📭 Chưa có sách nào trong thư viện.";
      } else {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const bookList = books.map(b =>
          `Tên: ${b.name}, Tác giả: ${b.author}, Thể loại: ${b.category}, Vị trí: ${b.position}`
        ).join("\n");

        const prompt = `
        Người dùng hỏi: "${message}"

        Đây là danh sách sách trong thư viện:
        ${bookList}

        Hãy chọn sách phù hợp nhất và trả lời tự nhiên (bao gồm Tên, Tác giả, Thể loại, Vị trí).
        Nếu không có sách phù hợp, hãy gợi ý chung chung.
        `;

        const response = await model.generateContent(prompt);
        reply = response.response.text() || "🤔 Tôi chưa nghĩ ra câu trả lời.";
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
