// server.js
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// Đường dẫn tuyệt đối
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đọc file Excel
const excelPath = path.join(__dirname, "books.xlsx");
const workbook = XLSX.readFile(excelPath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const books = XLSX.utils.sheet_to_json(sheet);
console.log("📚 Danh sách sách trong thư viện:", books);

// Khởi tạo Gemini SDK
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// API chat
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Thiếu field 'message' trong body" });
  }

  try {
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng mô tả tình trạng hoặc mong muốn: "${message}".
    Đây là danh sách sách trong thư viện:
    ${libraryText}

    Nhiệm vụ:
    - Chọn chính xác 1 quyển sách phù hợp nhất.
    - Trả về:
      Tên sách: ...
      Tác giả: ...
      Vị trí: ...
      Recap: ... (tối đa 3 câu)
    - Nếu không có sách phù hợp, trả lời: "Xin lỗi, hiện không tìm thấy sách nào phù hợp".
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const reply =
      response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Không có phản hồi.";

    res.json({ reply });
  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// Trả về index.html ở root
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
