// server.js
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đọc file Excel
const excelPath = path.join(__dirname, "books.xlsx");
let workbook, sheet, books;
if (fs.existsSync(excelPath)) {
  workbook = XLSX.readFile(excelPath);
  sheet = workbook.Sheets[workbook.SheetNames[0]];
  books = XLSX.utils.sheet_to_json(sheet);
} else {
  books = [];
}

// Hàm lưu Excel
function saveBooksToExcel(books) {
  const newSheet = XLSX.utils.json_to_sheet(books);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newSheet, "Sheet1");
  XLSX.writeFile(newWb, excelPath);
}

// SDK Gemini
const ai = new GoogleGenAI({});

// ==================== CHAT ====================
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu field 'message'" });

  try {
    // ----------------- ADD BOOK -----------------
    if (message.toLowerCase().startsWith("add book")) {
      // Ví dụ: add book: bn: Tên; at: Tác giả
      const regex = /bn:\s*(.+?);\s*at:\s*(.+)/i;
      const match = message.match(regex);
      if (!match) {
        return res.json({ reply: "❌ Sai cú pháp. Dùng: add book: bn: <Tên>; at: <Tác giả>" });
      }
      const [_, tenSach, tacGia] = match;

      // Nhờ Gemini đoán thể loại + vị trí
      const prompt = `
      Hãy phân loại sách "${tenSach}" của ${tacGia}.
      Trả về JSON: { "Thể loại": "...", "Vị trí": "..." }
      `;
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });

      let extra = {};
      try {
        extra = JSON.parse(response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
      } catch {
        extra = { "Thể loại": "Chưa rõ", "Vị trí": "Kho chung" };
      }

      const newBook = {
        "Tên sách": tenSach.trim(),
        "Tác giả": tacGia.trim(),
        "Thể loại": extra["Thể loại"] || "Chưa rõ",
        "Vị trí": extra["Vị trí"] || "Kho chung",
        "Tóm tắt": "Chưa có"
      };

      books.push(newBook);
      saveBooksToExcel(books);

      return res.json({ reply: `✅ Đã thêm sách:\n${JSON.stringify(newBook, null, 2)}` });
    }

    // ----------------- REMOVE BOOK -----------------
    if (message.toLowerCase().startsWith("remove book")) {
      // Ví dụ: remove book: bn: Tên; at: Tác giả
      const regex = /bn:\s*(.+?);\s*at:\s*(.+)/i;
      const match = message.match(regex);
      if (!match) {
        return res.json({ reply: "❌ Sai cú pháp. Dùng: remove book: bn: <Tên>; at: <Tác giả>" });
      }
      const [_, tenSach, tacGia] = match;

      const index = books.findIndex(
        b => b["Tên sách"].toLowerCase() === tenSach.trim().toLowerCase() &&
             b["Tác giả"].toLowerCase() === tacGia.trim().toLowerCase()
      );

      if (index === -1) {
        return res.json({ reply: "❌ Không tìm thấy sách để xoá." });
      }

      const removed = books.splice(index, 1);
      saveBooksToExcel(books);

      return res.json({ reply: `🗑️ Đã xoá sách:\n${JSON.stringify(removed[0], null, 2)}` });
    }

    // ----------------- SEARCH BOOK -----------------
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Thể loại: ${b["Thể loại"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng mô tả: "${message}"
    Đây là danh sách sách trong thư viện:
    ${libraryText}

    Nhiệm vụ:
    - Chọn ra chính xác 1 quyển sách phù hợp nhất với yêu cầu người dùng.
    - Trả về:
      Tên sách: ...
      Tác giả: ...
      Thể loại: ...
      Vị trí: ...
      Recap: ... (ngắn gọn tối đa 3 câu)
    - Nếu không có sách phù hợp, trả lời: "Xin lỗi, không tìm thấy sách nào phù hợp."
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const replyRaw = response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "Không có phản hồi.";
    const reply = replyRaw.replace(/\n/g, "<br>");

    res.json({ reply });
  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ==================== STATIC WEB ====================
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
