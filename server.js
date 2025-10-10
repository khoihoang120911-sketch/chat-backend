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

// PostgreSQL setup
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Gemini setup
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = ai.getGenerativeModel({ model: "gemini-2.5-flash" });

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

// ===== Helper: nhờ Gemini suy luận thể loại & vị trí =====
async function inferCategoryAndPosition(bookName, author) {
  const prompt = `
  Bạn là quản thủ thư viện.
  Với sách "${bookName}" của tác giả "${author}", hãy đoán:
  - Thể loại (ví dụ: Văn học, Lịch sử, Khoa học, Tâm lý,...)
  - Vị trí: ký tự đầu = chữ cái viết tắt thể loại, số = kệ (mỗi kệ chứa tối đa 15 quyển).

  Trả về theo format JSON:
  {"category": "...", "position": "..."}
  `;

  const result = await model.generateContent(prompt);
  try {
    return JSON.parse(result.response.text());
  } catch {
    return { category: "Chưa rõ", position: "?" };
  }
}

// ===== API Chat chính =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["user", message]);
    let reply = "";

    // Nếu user muốn thêm sách
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);?\s*at:\s*(.+)/i);
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

    // Nếu user muốn xoá sách
    else if (message.toLowerCase().startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);?\s*at:\s*(.+)/i);
      if (match) {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount > 0
          ? `🗑️ Đã xoá sách "${bookName}" của ${author}`
          : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      } else {
        reply = "❌ Sai cú pháp. Hãy dùng: `delete book: bn: Tên sách; at: Tác giả`";
      }
    }

    // Chat thường
    else {
      const history = await pool.query(
        "SELECT role, message FROM conversations ORDER BY created_at DESC LIMIT 10"
      );
      const historyText = history.rows.reverse()
        .map(h => `${h.role === "user" ? "Người dùng" : "Trợ lý"}: ${h.message}`)
        .join("\n");

      const prompt = `
      Đây là hội thoại:
      ${historyText}

      Nhiệm vụ:
      - Nếu người dùng cần sách, hãy chọn 1 quyển trong DB.
      - Hiển thị: Tên, Tác giả, Thể loại, Vị trí + recap ngắn.
      - Nếu chỉ trò chuyện, hãy trả lời tự nhiên.
      `;

      const result = await model.generateContent(prompt);
      reply = result.response.text() || "Không có phản hồi.";
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Gửi index.html khi vào / =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== Khởi động server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy trên cổng ${PORT}`);
});
