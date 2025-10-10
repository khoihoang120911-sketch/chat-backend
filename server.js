import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🔹 Hàm gọi Gemini (luôn dùng gemini-2.5-flash)
async function askGemini(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// 🔹 Người dùng nói tình trạng → tìm sách
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    // Lấy danh sách sách từ DB
    const { rows } = await pool.query("SELECT * FROM books");

    // Gửi sách + tình trạng cho Gemini để chọn
    const prompt = `
    Người dùng mô tả tình trạng: "${message}".
    Đây là danh sách sách trong thư viện (tên, tác giả, thể loại, vị trí):
    ${rows.map(b => `${b.title} - ${b.author} (${b.category}, ${b.position})`).join("\n")}

    👉 Nhiệm vụ của bạn:
    1. Chọn 1 cuốn sách phù hợp nhất với tình trạng người dùng.
    2. Tóm tắt (recap) ngắn gọn nội dung chính của cuốn sách.
    3. Trả về JSON theo dạng:
    {
      "title": "...",
      "author": "...",
      "category": "...",
      "position": "...",
      "recap": "..."
    }
    `;

    const geminiResponse = await askGemini(prompt);

    res.json({ answer: geminiResponse });
  } catch (err) {
    console.error("❌ Lỗi /chat:", err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// 🔹 Thêm sách mới
app.post("/add-book", async (req, res) => {
  let { title, author, category, position } = req.body;

  try {
    // Nếu thiếu category hoặc position → nhờ Gemini tìm
    if (!category || !position) {
      const prompt = `
      Tôi có sách:
      - Tên: "${title}"
      - Tác giả: "${author}"

      Hãy tra cứu nhanh và suy đoán:
      1. Thể loại (category) của sách này
      2. Vị trí (position) gợi ý trong thư viện (ví dụ A1, B2, C3...).

      Trả về JSON: { "category": "...", "position": "..." }
      `;
      const geminiResponse = await askGemini(prompt);

      try {
        const parsed = JSON.parse(geminiResponse);
        category = category || parsed.category;
        position = position || parsed.position;
      } catch {
        console.warn("⚠️ Không parse được Gemini response, dùng mặc định.");
        if (!category) category = "Chưa phân loại";
        if (!position) position = "Z0";
      }
    }

    await pool.query(
      "INSERT INTO books (title, author, category, position) VALUES ($1, $2, $3, $4)",
      [title, author, category, position]
    );

    res.json({
      message: "✅ Đã thêm sách thành công",
      book: { title, author, category, position },
    });
  } catch (err) {
    console.error("❌ Lỗi /add-book:", err);
    res.status(500).json({ error: "Không thể thêm sách" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
