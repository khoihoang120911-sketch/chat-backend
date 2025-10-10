// server.js
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Lấy đường dẫn tuyệt đối
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đọc file Excel
const excelPath = path.join(__dirname, "books.xlsx");
let workbook = XLSX.readFile(excelPath);
let sheet = workbook.Sheets[workbook.SheetNames[0]];
let books = XLSX.utils.sheet_to_json(sheet);

// SDK Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

console.log("📚 Khởi động với", books.length, "sách.");

// =======================
// API CHAT
// =======================
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });

  try {
    // -------------------
    // XỬ LÝ ADD BOOK
    // -------------------
    if (message.toLowerCase().startsWith("add book")) {
      const match = message.match(/bn:\s*(.*?); at:\s*(.*)/i);
      if (!match) {
        return res.json({ reply: "❌ Sai cú pháp! Ví dụ: add book: bn: Tên sách; at: Tác giả" });
      }

      const tenSach = match[1].trim();
      const tacGia = match[2].trim();

      // Gọi Gemini phân loại + recap
      const classifyPrompt = `
      Hãy phân tích sách với thông tin:
      - Tên sách: "${tenSach}"
      - Tác giả: "${tacGia}"

      Nhiệm vụ:
      1. Đưa ra thể loại (ngắn gọn, ví dụ: Văn học, Lịch sử, Khoa học, Tâm lý…).
      2. Tạo recap ngắn gọn 2 câu.
      Trả về JSON với các field: { "TheLoai": ..., "TomTat": ... }.
      `;

      const classifyRes = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: classifyPrompt
      });

      let info = {};
      try {
        info = JSON.parse(classifyRes.response.candidates[0].content.parts[0].text);
      } catch (e) {
        info = { TheLoai: "Khác", TomTat: "Chưa có" };
      }

      // Tính vị trí: 15 quyển / kệ
      const loai = info.TheLoai || "Khác";
      const prefix = loai[0].toUpperCase();
      const count = books.filter(b => (b["Thể loại"] || "").startsWith(loai)).length;
      const ke = Math.floor(count / 15) + 1;
      const viTri = `${prefix}${ke}`;

      const newBook = {
        "Tên sách": tenSach,
        "Tác giả": tacGia,
        "Thể loại": loai,
        "Vị trí": viTri,
        "Tóm tắt": info.TomTat
      };

      books.push(newBook);

      // Ghi lại Excel
      const newSheet = XLSX.utils.json_to_sheet(books);
      const newWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(newWb, newSheet, "Books");
      XLSX.writeFile(newWb, excelPath);

      return res.json({ reply: `✅ Đã thêm sách:\n${JSON.stringify(newBook, null, 2)}` });
    }

    // -------------------
    // XỬ LÝ DELETE BOOK
    // -------------------
    if (message.toLowerCase().startsWith("del book")) {
      const match = message.match(/bn:\s*(.*?); at:\s*(.*)/i);
      if (!match) {
        return res.json({ reply: "❌ Sai cú pháp! Ví dụ: del book: bn: Tên sách; at: Tác giả" });
      }

      const tenSach = match[1].trim();
      const tacGia = match[2].trim();

      const index = books.findIndex(
        b => b["Tên sách"].toLowerCase() === tenSach.toLowerCase() &&
             b["Tác giả"].toLowerCase() === tacGia.toLowerCase()
      );

      if (index === -1) {
        return res.json({ reply: `⚠️ Không tìm thấy sách: ${tenSach} - ${tacGia}` });
      }

      const removed = books.splice(index, 1)[0];

      // Ghi lại Excel
      const newSheet = XLSX.utils.json_to_sheet(books);
      const newWb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(newWb, newSheet, "Books");
      XLSX.writeFile(newWb, excelPath);

      return res.json({ reply: `🗑️ Đã xóa sách:\n${JSON.stringify(removed, null, 2)}` });
    }

    // -------------------
    // TÌM SÁCH PHÙ HỢP
    // -------------------
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Thể loại: ${b["Thể loại"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng mô tả: "${message}".
    Đây là danh sách sách:
    ${libraryText}

    Nhiệm vụ:
    - Chọn 1 quyển sách phù hợp nhất.
    - Trả về định dạng:
      Tên sách: ...
      Tác giả: ...
      Vị trí: ...
      Recap: ... (tối đa 3 câu)
    - Nếu không có sách phù hợp, trả lời: "Xin lỗi, không tìm thấy sách nào phù hợp".
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const reply = response.response.candidates[0].content.parts[0].text;
    res.json({ reply });

  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// =======================
// STATIC + RUN
// =======================
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
