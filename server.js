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

// ===== Helper: gán vị trí kệ tự động =====
async function assignPosition(category) {
  const letter = category ? category[0].toUpperCase() : "X";

  const existing = await pool.query(
    "SELECT COUNT(*) FROM books WHERE category=$1",
    [category]
  );
  const count = parseInt(existing.rows[0].count || "0");
  const shelf = Math.floor(count / 15) + 1; // mỗi kệ chứa 15 quyển
  return `${letter}${shelf}`;
}

// ===== Helper: suy luận thể loại & vị trí từ Gemini =====
async function inferCategoryAndPosition(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là quản thủ thư viện.
Nhiệm vụ: Dựa trên thông tin web, xác định thể loại cho cuốn:
- Tên: "${bookName}"
- Tác giả: "${author}"

Các thể loại hợp lệ (chọn gần nhất):
["Văn học", "Lịch sử", "Khoa học", "Kinh tế", "Tâm lý", "Triết học", "Công nghệ", "Chính trị", "Giáo dục", "Khác"]

Trả về JSON:
{"category": "Thể loại"}
  `;

  try {
    const response = await model.generateContent(prompt);
    const text = response.response.text();
    const parsed = JSON.parse(text);
    const category = parsed.category || "Chưa rõ";
    const position = await assignPosition(category);
    return { category, position };
  } catch (err) {
    console.error("❌ Lỗi khi suy luận thể loại:", err);
    return { category: "Chưa rõ", position: "X?" };
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

    // ===== Gợi ý / Chat thông minh =====
    else {
      const result = await pool.query("SELECT name, author, category, position FROM books");
      const books = result.rows;

      if (books.length === 0) {
        reply = "📭 Thư viện hiện chưa có sách.";
      } else {
        // Lấy lịch sử hội thoại gần nhất để duy trì ngữ cảnh
        const history = await pool.query(
          "SELECT role, message FROM conversations ORDER BY id DESC LIMIT 10"
        );
        const messages = history.rows.reverse();

        let context = "";
        for (const msg of messages) {
          context += `${msg.role === "user" ? "👤 Người dùng" : "🤖 Trợ lý"}: ${msg.message}\n`;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
Bạn là trợ lý thư viện thông minh.
Dưới đây là đoạn hội thoại trước:
${context}

Người dùng vừa nói: "${message}"

Danh sách sách trong thư viện:
${JSON.stringify(books, null, 2)}

Nhiệm vụ:
1. Chọn cuốn sách phù hợp nhất (nếu có).
2. Trả về JSON:
{
  "title": "Tên sách",
  "author": "Tác giả",
  "category": "Thể loại",
  "location": "Vị trí",
  "reason": "Lý do gợi ý"
}
Nếu không tìm được, trả về {"title": "", "reason": "Không rõ"}.
`;

        const response = await model.generateContent(prompt);
        const raw = response.response.text();

        try {
          const book = JSON.parse(raw);
          if (book.title) {
            reply = `📚 Gợi ý: "${book.title}" (${book.author})\nThể loại: ${book.category}, Vị trí: ${book.location}\n💡 Lý do: ${book.reason}`;
          } else {
            reply = "🤔 Tôi chưa tìm ra cuốn nào phù hợp.";
          }
        } catch {
          reply = "🤔 Tôi chưa tìm ra cuốn nào phù hợp.";
        }
      }
    }

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
