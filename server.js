import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Kết nối PostgreSQL ---
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Kết nối Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Middleware
app.use(bodyParser.json());
app.use(express.static(".")); // phục vụ index.html cùng thư mục

// Hàm suy luận thể loại + vị trí bằng Gemini
async function inferCategoryAndPosition(bookName, author) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
    Bạn là quản thủ thư viện.
    Với sách "${bookName}" của tác giả "${author}", hãy đoán:
    - Thể loại (ví dụ: Văn học, Lịch sử, Khoa học, Tâm lý,...)
    - Vị trí: ký tự đầu = chữ cái viết tắt thể loại, số = kệ (mỗi kệ chứa tối đa 15 quyển).

    Trả về JSON:
    {"category": "...", "position": "..."}
    `;

    const response = await model.generateContent(prompt);

    const text = response.response.text().trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("Gemini error:", err);
    return { category: "Chưa rõ", position: "?" };
  }
}

// API xử lý chat
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  try {
    let reply = "";

    // Nếu user nhập thêm sách
    if (message.toLowerCase().startsWith("add book:")) {
      const parts = message.replace("add book:", "").split(";").map(p => p.trim());
      const bookName = parts[0]?.replace("bn:", "").trim();
      const author = parts[1]?.replace("at:", "").trim();

      if (!bookName || !author) {
        reply = "❌ Sai cú pháp. Hãy nhập: add book: bn: Tên sách; at: Tác giả";
      } else {
        const { category, position } = await inferCategoryAndPosition(bookName, author);

        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1, $2, $3, $4)",
          [bookName, author, category, position]
        );

        reply = `✅ Đã thêm sách: "${bookName}" (Tác giả: ${author}, Thể loại: ${category}, Vị trí: ${position})`;
      }
    }
    // Nếu user nhập xóa sách
    else if (message.toLowerCase().startsWith("delete book:")) {
      const bookName = message.replace("delete book:", "").trim();
      await pool.query("DELETE FROM books WHERE name ILIKE $1", [bookName]);

      reply = `🗑️ Đã xóa sách "${bookName}" (nếu tồn tại).`;
    }
    // Nếu user nhập tìm sách
    else {
      // gọi Gemini để phân tích tình trạng người dùng
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const prompt = `
      Người dùng nói: "${message}".
      Dựa trên nội dung, hãy trả lời bằng JSON:
      {
        "mood": "tâm trạng hoặc nhu cầu",
        "suggestCategory": "thể loại sách phù hợp"
      }
      `;

      const aiRes = await model.generateContent(prompt);
      const text = aiRes.response.text().trim();

      let suggest = {};
      try {
        suggest = JSON.parse(text);
      } catch {
        suggest = { mood: "không rõ", suggestCategory: "Văn học" };
      }

      const dbRes = await pool.query(
        "SELECT * FROM books WHERE category ILIKE $1 LIMIT 3",
        [suggest.suggestCategory]
      );

      if (dbRes.rows.length > 0) {
        reply = `📖 Tôi đề xuất vài cuốn thuộc thể loại *${suggest.suggestCategory}*: \n- ` +
          dbRes.rows.map(b => `${b.name} (tác giả: ${b.author}, vị trí: ${b.position})`).join("\n- ");
      } else {
        reply = `❌ Hiện không tìm thấy sách trong thể loại "${suggest.suggestCategory}".`;
      }
    }

    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    res.json({ reply: "❌ Có lỗi xảy ra khi xử lý." });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server chạy tại http://localhost:${port}`);
});
