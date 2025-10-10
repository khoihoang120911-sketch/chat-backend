import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import xlsx from "xlsx";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Đường dẫn file Excel
const excelFilePath = path.join(process.cwd(), "books.xlsx");

// Đọc file Excel
function readExcel() {
  if (!fs.existsSync(excelFilePath)) {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([]);
    xlsx.utils.book_append_sheet(wb, ws, "Books");
    xlsx.writeFile(wb, excelFilePath);
  }
  const wb = xlsx.readFile(excelFilePath);
  const ws = wb.Sheets["Books"];
  return xlsx.utils.sheet_to_json(ws || []);
}

// Ghi Excel
function writeExcel(data) {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(data);
  xlsx.utils.book_append_sheet(wb, ws, "Books");
  xlsx.writeFile(wb, excelFilePath);
}

// Đếm số sách trong 1 kệ
function countBooksInShelf(books, shelf) {
  return books.filter(b => b["Vị trí"] === shelf).length;
}

// Tìm vị trí hợp lệ cho sách mới
function assignShelf(books, baseShelf) {
  if (!baseShelf) return "Kho chung";

  const match = baseShelf.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return baseShelf;

  const prefix = match[1];
  let shelfNumber = parseInt(match[2], 10);

  while (true) {
    const shelfCode = `${prefix}${shelfNumber}`;
    const count = countBooksInShelf(books, shelfCode);
    if (count < 15) return shelfCode;
    shelfNumber++;
  }
}

// Mapping thể loại → kệ (lấy từ Excel gốc hoặc config)
const genreMapFromExcel = {
  "Văn học": "B1",
  "Lịch sử": "C1",
  "Khoa học": "D1",
  "Tâm lý": "E1",
  "Thiếu nhi": "F1"
};

// API Chat chính
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  let books = readExcel();

  try {
    // Nếu lệnh thêm sách
    if (message.toLowerCase().startsWith("add book:")) {
      const parts = message.split(";");
      const namePart = parts[0].split("bn:")[1]?.trim();
      const authorPart = parts[1]?.split("at:")[1]?.trim();

      if (!namePart || !authorPart) {
        return res.json({ reply: "❌ Sai cú pháp. Dùng: add book: bn: Tên; at: Tác giả" });
      }

      // Nhờ Gemini phân loại
      const genreResp = await model.generateContent(
        `Cho tôi thể loại của quyển sách "${namePart}" của tác giả "${authorPart}". 
         Trả về CHỈ tên thể loại (ví dụ: Văn học, Lịch sử, Khoa học, Tâm lý, Thiếu nhi).`
      );
      const theLoai = genreResp.response.text().trim();

      // Gán vị trí tự động
      const baseShelf = genreMapFromExcel[theLoai] || "Z1";
      const viTri = assignShelf(books, baseShelf);

      const newBook = {
        "Tên sách": namePart,
        "Tác giả": authorPart,
        "Thể loại": theLoai,
        "Vị trí": viTri,
      };

      books.push(newBook);
      writeExcel(books);

      return res.json({
        reply: `✅ Đã thêm sách:\n- Tên: ${namePart}\n- Tác giả: ${authorPart}\n- Thể loại: ${theLoai}\n- Vị trí: ${viTri}`
      });
    }

    // Nếu lệnh xóa sách
    if (message.toLowerCase().startsWith("delete book:")) {
      const parts = message.split(";");
      const namePart = parts[0].split("bn:")[1]?.trim();
      const authorPart = parts[1]?.split("at:")[1]?.trim();

      const beforeCount = books.length;
      books = books.filter(
        b => !(b["Tên sách"] === namePart && b["Tác giả"] === authorPart)
      );

      if (books.length === beforeCount) {
        return res.json({ reply: `❌ Không tìm thấy sách "${namePart}" của "${authorPart}".` });
      }

      writeExcel(books);
      return res.json({ reply: `🗑️ Đã xóa sách "${namePart}" của "${authorPart}".` });
    }

    // Nếu là câu hỏi bình thường → hỏi Gemini
    const prompt = `
    Người dùng: ${message}
    Nhiệm vụ: Chọn đúng 1 quyển sách từ danh sách sau (file Excel) phù hợp nhất với yêu cầu.
    Trả về:
    - Tên sách
    - Tác giả
    - Thể loại
    - Vị trí
    - Recap ngắn gọn về nội dung sách

    Danh sách sách: ${JSON.stringify(books)}
    `;
    const result = await model.generateContent(prompt);
    res.json({ reply: result.response.text() });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "❌ Lỗi xử lý." });
  }
});

app.listen(3000, () => console.log("✅ Server đang chạy tại cổng 3000"));
