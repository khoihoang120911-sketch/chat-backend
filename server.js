import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Gemini setup
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      prefix CHAR(1) NOT NULL
    )
  `);

  // Seed categories nếu trống
  const existing = await pool.query("SELECT COUNT(*) FROM categories");
  if (parseInt(existing.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO categories (name, prefix) VALUES
      ('Công nghệ','A'),
      ('Văn học','B'),
      ('Lịch sử','C'),
      ('Kinh tế','D'),
      ('Khoa học','E')
    `);
  }
}
initTables();

// ===== Helper: suy luận thể loại =====
async function inferCategory(bookName, author) {
  const prompt = `
  Bạn là quản thủ thư viện.
  Với sách "${bookName}" của tác giả "${author}", hãy đoán thể loại phù hợp trong các nhóm:
  - Công nghệ
  - Văn học
  - Lịch sử
  - Kinh tế
  - Khoa học

  Chỉ trả về 1 từ: tên thể loại.
  `;
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt
  });
  const text = response.response.candidates[0].content.parts[0].text.trim();
  return text || "Chưa rõ";
}

// ===== Helper: tìm vị trí dựa vào category =====
async function findPosition(category) {
  // Lấy prefix
  const result = await pool.query("SELECT prefix FROM categories WHERE name=$1", [category]);
  if (result.rows.length === 0) return "?";
  const prefix = result.rows[0].prefix;

  // Kiểm tra kệ đã đầy chưa (15 quyển/kệ)
  let shelf = 1;
  while (true) {
    const position = `${prefix}${shelf}`;
    const count = await pool.query("SELECT COUNT(*) FROM books WHERE position=$1", [position]);
    if (parseInt(count.rows[0].count) < 15) {
      return position;
    }
    shelf++;
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

        const category = await inferCategory(bookName, author);
        const position = await findPosition(category);

        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName, author, category, position]
        );

        reply = `✅ Đã thêm sách: "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      } else {
        reply = "❌ Sai cú pháp. Hãy dùng: `add book: bn: Tên sách; at: Tác giả`";
      }
    }

    // Nếu user muốn cập nhật thể loại
    else if (message.toLowerCase().includes("thể loại là")) {
      const match = message.match(/sách\s+"(.+)"|(.+)\s+thể loại là\s+(.+)/i);
      if (match) {
        const bookName = match[1] || match[2];
        const newCategory = match[3].trim();
        const newPosition = await findPosition(newCategory);

        await pool.query(
          "UPDATE books SET category=$1, position=$2 WHERE name ILIKE $3",
          [newCategory, newPosition, `%${bookName}%`]
        );

        reply = `🔄 Đã cập nhật thể loại cho "${bookName}" thành ${newCategory}, vị trí: ${newPosition}`;
      } else {
        reply = "❌ Không hiểu sách nào bạn muốn cập nhật.";
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

    // Nếu chỉ chat
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
      - Nếu người dùng cần sách, hãy chọn từ DB.
      - Trả về: Tên, Tác giả, Thể loại, Vị trí.
      - Nếu chỉ trò chuyện, trả lời tự nhiên.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });

      reply = response.response.candidates[0].content.parts[0].text || "Không có phản hồi.";
    }

    // Lưu trả lời
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1,$2)", ["assistant", reply]);

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Route trả về index.html =====
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/", async (req, res) => {
  const html = await readFile(path.join(__dirname, "index.html"), "utf-8");
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server chạy trên cổng ${PORT}`);
});
