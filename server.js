import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });

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

  Trả về JSON hợp lệ:
  {"category": "...", "position": "..."}
  `;

  const response = await model.generateContent(prompt);
  try {
    return JSON.parse(response.response.text());
  } catch {
    return { category: "Chưa rõ", position: "?" };
  }
}

// ===== API Chat chính =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    // Lưu user message
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["user", message]);

    let reply = "";

    // Nếu user muốn thêm sách
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (match) {
        const bookName = match[1].trim();
        const author = match[2].trim();

        // Gemini suy luận thể loại + vị trí
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

    // Nếu user muốn tìm sách (Gemini suy luận nhu cầu)
    else if (message.toLowerCase().includes("tìm sách") || message.toLowerCase().includes("find book")) {
      const result = await pool.query("SELECT * FROM books LIMIT 50");

      if (result.rowCount === 0) {
        reply = "📭 Hiện chưa có sách nào trong thư viện.";
      } else {
        const bookList = result.rows.map(
          b => `- "${b.name}" (${b.author}) | ${b.category} | Vị trí: ${b.position}`
        ).join("\n");

        const prompt = `
        Người dùng đang cần: "${message}"

        Đây là danh sách sách trong thư viện:
        ${bookList}

        Hãy chọn ra 1-3 cuốn phù hợp nhất với nhu cầu trên.
        Trả về gọn gàng như sau:
        Tên: ...
        Tác giả: ...
        Thể loại: ...
        Vị trí: ...
        Giải thích: ...
        `;

        const response = await model.generateContent(prompt);
        reply = response.response.text().trim() || "Không tìm thấy sách phù hợp.";
      }
    }

    // Nếu user chỉ chat bình thường
    else {
      // Lấy hội thoại gần nhất
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

      const response = await model.generateContent(prompt);
      reply = response.response.text().trim() || "Không có phản hồi.";
    }

    // Lưu trả lời
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Khởi động server + phục vụ index.html =====
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Route mặc định: trả về file index.html trong cùng thư mục với server.js
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});

