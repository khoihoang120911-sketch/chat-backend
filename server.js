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

// Lấy đường dẫn tuyệt đối đến thư mục chứa server.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đọc file Excel "books.xlsx" trong cùng thư mục với server.js
const excelPath = path.join(__dirname, "books.xlsx");
const workbook = XLSX.readFile(excelPath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const books = XLSX.utils.sheet_to_json(sheet);

console.log("📚 Danh sách sách trong thư viện:", books);

// SDK sẽ đọc GEMINI_API_KEY từ biến môi trường Render
const ai = new GoogleGenAI({});

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu field 'message' trong body" });

  try {
    // Ghép dữ liệu sách thành văn bản
    const libraryText = books.map(b =>
      `Tên: ${b["Tên sách"]}, Tác giả: ${b["Tác giả"]}, Vị trí: ${b["Vị trí"]}, Tóm tắt: ${b["Tóm tắt"]}`
    ).join("\n");

    const prompt = `
    Người dùng mô tả tình trạng hoặc mong muốn của mình: "${message}".
    Đây là danh sách sách trong thư viện:
    ${libraryText}
    
    Nhiệm vụ:
    - Hiểu tình trạng/mong muốn của người dùng và chọn ra **chính xác 1 quyển sách phù hợp nhất**.
    - Trả về theo định dạng sau:
      Tên sách: ...
      Tác giả: ...
      Vị trí: ...
      Recap: ... (tóm tắt ngắn gọn, tối đa 3 câu)
    - Nếu không có sách phù hợp, hãy trả lời: "Xin lỗi, hiện không tìm thấy sách nào phù hợp".
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt
    });

    const reply =
      response?.text ??
      response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Không có phản hồi.";
    res.json({ reply });
  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
