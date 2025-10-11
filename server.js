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

// ===== Seed dữ liệu lần đầu =====
import("./seedBooks.js");

// ===== Helper: Suy luận thể loại & vị trí =====
async function inferCategoryAndPosition(bookName, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `
Bạn là quản thủ thư viện thông minh. 
Hãy suy luận THỂ LOẠI cho cuốn sách sau dựa vào tên và tác giả:

Tên: "${bookName}"
Tác giả: "${author}"

Trả về JSON:
{
  "category": "tên thể loại ngắn gọn, ví dụ: Văn học, Khoa học, Tâm lý học...",
  "positionRule": "Giải thích quy tắc xếp kệ"
}

⚠️ KHÔNG viết thêm văn bản ngoài JSON.
`;

  try {
    const response = await model.generateContent(prompt);
    const data = JSON.parse(response.response.text());

    // Tạo mã vị trí theo thể loại
    const letter = data.category ? data.category[0].toUpperCase() : "X";

    // Đếm xem đã có bao nhiêu sách cùng thể loại để tính kệ
    const { rows } = await pool.query("SELECT COUNT(*) FROM books WHERE category=$1", [data.category]);
    const count = parseInt(rows[0].count) || 0;
    const shelf = Math.floor(count / 15) + 1; // mỗi kệ chứa 15 quyển
    const position = `${letter}${shelf}`;

    return { category: data.category || "Chưa rõ", position };
  } catch (e) {
    console.error("⚠️ Lỗi khi suy luận thể loại:", e.message);
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
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["user", message]);

    let reply = "";

    // ===== ADD BOOK =====
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

    // ===== DELETE BOOK =====
    else if (message.toLowerCase().startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (match) {
        const bookName = match[1].trim();
        const author = match[2].trim();

        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount
          ? `🗑️ Đã xoá sách "${bookName}" của ${author}`
          : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      } else {
        reply = "❌ Sai cú pháp. Hãy dùng: `delete book: bn: Tên sách; at: Tác giả`";
      }
    }

    // ===== GEMINI TÌM SÁCH =====
    else {
      const { rows: books } = await pool.query("SELECT name, author, category, position FROM books");
      if (books.length === 0) return res.json({ reply: "📭 Thư viện hiện chưa có sách." });

      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const prompt = `
Người dùng vừa nói: "${message}".
Đây là danh sách sách trong thư viện (JSON): ${JSON.stringify(books, null, 2)}.

Yêu cầu:
- Chỉ chọn 1 cuốn sách trong danh sách trên, KHÔNG bịa thêm.
- Phải trả về JSON hợp lệ:
{
  "title": "Tên sách trong DB",
  "author": "Tác giả trong DB",
  "category": "Thể loại trong DB",
  "location": "Vị trí trong DB",
  "reason": "Lý do chọn cuốn này"
}`;

      const response = await model.generateContent(prompt);
      const raw = response.response.text();
      console.log("🧠 Gemini raw output:", raw);

      try {
        const book = JSON.parse(raw);
        reply = `📚 Gợi ý: "${book.title}" (${book.author})
Thể loại: ${book.category}, Vị trí: ${book.location}
💡 Lý do: ${book.reason}`;
      } catch (e) {
        console.warn("⚠️ Lỗi parse Gemini output:", e.message);

        // fallback chọn sách gần khớp
        const keyword = message.toLowerCase();
        const fallback =
          books.find(b => keyword.includes(b.category?.toLowerCase())) ||
          books.find(b => keyword.includes(b.name?.toLowerCase())) ||
          books[Math.floor(Math.random() * books.length)];

        reply = `📚 Gợi ý: "${fallback.name}" (${fallback.author})
Thể loại: ${fallback.category}, Vị trí: ${fallback.position}
💡 Lý do: Tôi chọn cuốn này vì nó có vẻ phù hợp với yêu cầu của bạn.`;
      }
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server đang chạy trên cổng ${PORT}`);
});
