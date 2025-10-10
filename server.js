// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// Khởi tạo Express
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Tạo __dirname vì đang dùng module ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// File Excel
const excelPath = path.join(__dirname, "books.xlsx");
let workbook, sheet, books = [];

if (fs.existsSync(excelPath)) {
  workbook = XLSX.readFile(excelPath);
  const sheetName = workbook.SheetNames[0];
  sheet = workbook.Sheets[sheetName];
  books = XLSX.utils.sheet_to_json(sheet);
} else {
  workbook = XLSX.utils.book_new();
  sheet = XLSX.utils.json_to_sheet([]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Library");
  books = [];
  XLSX.writeFile(workbook, excelPath);
}

// Lưu file Excel
function saveBooks() {
  const newSheet = XLSX.utils.json_to_sheet(books);
  workbook.Sheets[workbook.SheetNames[0]] = newSheet;
  XLSX.writeFile(workbook, excelPath);
}

// Hàm tạo vị trí dựa trên thể loại
function assignPosition(category) {
  const letter = category?.charAt(0)?.toUpperCase() || "X";
  const sameCategory = books.filter(b => b["Thể loại"]?.charAt(0)?.toUpperCase() === letter);
  const shelfNumber = Math.floor(sameCategory.length / 15) + 1;
  return `${letter}${shelfNumber}`;
}

// Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Route chat
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    // ====== 1. LỆNH THÊM SÁCH ======
    if (message.toLowerCase().startsWith("add book")) {
      const nameMatch = message.match(/bn:\s*([^;]+)/i);
      const authorMatch = message.match(/at:\s*([^;]+)/i);

      if (!nameMatch || !authorMatch) {
        return res.json({ reply: "❌ Sai cú pháp. Ví dụ: add book: bn: Tên; at: Tác giả" });
      }

      const bookName = nameMatch[1].trim();
      const author = authorMatch[1].trim();

      // Hỏi Gemini thể loại + tóm tắt
      const prompt = `Cho tôi biết thể loại và tóm tắt ngắn gọn (2 câu) của sách "${bookName}" của tác giả "${author}".
Trả lời đúng JSON:
{
  "Thể loại": "...",
  "Tóm tắt": "..."
}`;

      const aiResp = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" })
        .generateContent(prompt);

      let aiText = aiResp.response.text();
      let category = "Khác", summary = "Chưa có";

      try {
        const parsed = JSON.parse(aiText);
        category = parsed["Thể loại"] || "Khác";
        summary = parsed["Tóm tắt"] || "Chưa có";
      } catch {
        console.warn("AI trả về không phải JSON, fallback text:", aiText);
      }

      const position = assignPosition(category);

      const newBook = {
        "Tên sách": bookName,
        "Tác giả": author,
        "Thể loại": category,
        "Vị trí": position,
        "Tóm tắt": summary
      };

      books.push(newBook);
      saveBooks();

      return res.json({ reply: `✅ Đã thêm sách:\n${JSON.stringify(newBook, null, 2)}` });
    }

    // ====== 2. LỆNH XÓA SÁCH ======
    if (message.toLowerCase().startsWith("delete book")) {
      const nameMatch = message.match(/bn:\s*([^;]+)/i);
      const authorMatch = message.match(/at:\s*([^;]+)/i);

      if (!nameMatch || !authorMatch) {
        return res.json({ reply: "❌ Sai cú pháp. Ví dụ: delete book: bn: Tên; at: Tác giả" });
      }

      const bookName = nameMatch[1].trim();
      const author = authorMatch[1].trim();

      const before = books.length;
      books = books.filter(
        b => !(b["Tên sách"] === bookName && b["Tác giả"] === author)
      );
      saveBooks();

      if (books.length < before) {
        return res.json({ reply: `🗑️ Đã xóa sách "${bookName}" của tác giả "${author}".` });
      } else {
        return res.json({ reply: `❌ Không tìm thấy sách "${bookName}" của tác giả "${author}".` });
      }
    }

    // ====== 3. TÌM SÁCH ======
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Thể loại: ${b["Thể loại"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
Người dùng mô tả mong muốn: "${message}".
Danh sách sách:
${libraryText}

Nhiệm vụ:
- Chọn đúng 1 quyển sách phù hợp nhất.
- Trả về:
Tên sách: ...
Tác giả: ...
Vị trí: ...
Recap: ... (tối đa 3 câu)
- Nếu không có sách phù hợp, trả lời: "Xin lỗi, hiện không tìm thấy sách nào phù hợp".
`;

    const response = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" })
      .generateContent(prompt);

    const reply = response.response.text();
    res.json({ reply });

  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message || "Lỗi không xác định" });
  }
});

// Serve file tĩnh (index.html)
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
