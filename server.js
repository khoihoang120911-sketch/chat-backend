// server.js
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// ====== Đường dẫn file Excel ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const excelPath = path.join(__dirname, "books.xlsx");

// ====== Load sách từ Excel ======
function loadBooks() {
  const workbook = XLSX.readFile(excelPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

// ====== Lưu sách ra Excel ======
function saveBooks(books) {
  const ws = XLSX.utils.json_to_sheet(books);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Books");
  XLSX.writeFile(wb, excelPath);
}

// Khởi tạo thư viện
let books = loadBooks();

// ====== Gemini API ======
const ai = new GoogleGenAI({});

// ====== History hội thoại ======
let history = [];

// ====== Chat endpoint ======
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });

  try {
    // === Lệnh thêm sách ===
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*(.*?);\s*at:\s*(.*)/i);
      if (!match) return res.json({ reply: "Sai cú pháp! Dùng: add book: bn: Tên sách; at: Tác giả" });

      const tenSach = match[1].trim();
      const tacGia = match[2].trim();

      // Nhờ Gemini suy luận thể loại + vị trí
      const classifyPrompt = `
      Hãy cho biết thể loại và vị trí cho quyển sách sau:
      Tên: "${tenSach}"
      Tác giả: "${tacGia}"

      Quy tắc:
      - Thể loại: Văn học, Lịch sử, Khoa học, Tâm lý, Triết học, Khác.
      - Vị trí: Gồm chữ cái (thể loại) + số kệ. Mỗi kệ chứa tối đa 15 sách. 
        Ví dụ: "V1" = kệ 1 văn học, "L2" = kệ 2 lịch sử.
      - Trả về JSON: { "Thể loại": "...", "Vị trí": "..." }
      `;

      const classifyRes = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: classifyPrompt }] }]
      });

      let result;
      try {
        result = JSON.parse(classifyRes.response.candidates[0].content.parts[0].text);
      } catch {
        result = { "Thể loại": "Khác", "Vị trí": "K1" };
      }

      const newBook = {
        "Tên sách": tenSach,
        "Tác giả": tacGia,
        "Thể loại": result["Thể loại"] || "Khác",
        "Vị trí": result["Vị trí"] || "K1",
        "Tóm tắt": "Chưa có"
      };

      books.push(newBook);
      saveBooks(books);

      return res.json({
        reply: `✅ Đã thêm sách:\n${JSON.stringify(newBook, null, 2)}`
      });
    }

    // === Lệnh xóa sách ===
    if (message.toLowerCase().startsWith("delete book")) {
      const match = message.match(/bn:\s*(.*?);\s*at:\s*(.*)/i);
      if (!match) return res.json({ reply: "Sai cú pháp! Dùng: delete book: bn: Tên sách; at: Tác giả" });

      const tenSach = match[1].trim();
      const tacGia = match[2].trim();

      const before = books.length;
      books = books.filter(b => !(b["Tên sách"] === tenSach && b["Tác giả"] === tacGia));
      saveBooks(books);

      if (books.length < before) {
        return res.json({ reply: `🗑️ Đã xóa sách "${tenSach}" của ${tacGia}` });
      } else {
        return res.json({ reply: `Không tìm thấy sách "${tenSach}" của ${tacGia}` });
      }
    }

    // === Chat tìm sách ===
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Thể loại: ${b["Thể loại"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng: "${message}".
    Đây là danh sách sách trong thư viện:
    ${libraryText}

    Nhiệm vụ:
    - Hiểu tình trạng/mong muốn của người dùng.
    - Chọn đúng **1 quyển sách phù hợp nhất**.
    - Trả về:
      Tên sách: ...
      Tác giả: ...
      Vị trí: ...
      Recap: ... (tối đa 3 câu)
    - Nếu không có sách phù hợp: "Xin lỗi, hiện không tìm thấy sách nào phù hợp".
    `;

    // Lưu input vào history
    history.push({ role: "user", parts: [{ text: message }] });

    // Gọi Gemini với toàn bộ history
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [...history, { role: "user", parts: [{ text: prompt }] }]
    });

    const reply = response.response.candidates[0].content.parts[0].text;

    // Lưu output vào history
    history.push({ role: "model", parts: [{ text: reply }] });

    res.json({ reply });

  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
