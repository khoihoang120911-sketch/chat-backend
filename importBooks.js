import fs from "fs";
import xlsx from "xlsx";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

// Kết nối database (Render sẽ lấy từ biến môi trường DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importBooks() {
  try {
    // Kiểm tra file Excel có tồn tại không
    if (!fs.existsSync("books.xlsx")) {
      console.error("❌ Không tìm thấy file books.xlsx trong repo!");
      process.exit(1);
    }

    // Đọc file Excel
    const workbook = xlsx.readFile("books.xlsx");
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    console.log(`📖 Đang import ${data.length} sách từ file Excel...`);

    for (let row of data) {
      const title = row["title"] || row["Tên sách"];
      const author = row["author"] || row["Tác giả"];
      const category = row["category"] || row["Thể loại"];
      const location = row["location"] || row["Vị trí"];

      if (!title) {
        console.warn("⚠️ Bỏ qua 1 dòng vì thiếu tên sách");
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO books (title, author, category, location)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (title) DO NOTHING`,
          [title, author, category, location]
        );
        console.log(`✅ Đã thêm: ${title} (${author})`);
      } catch (err) {
        console.error(`❌ Lỗi khi thêm sách "${title}":`, err.message);
      }
    }

    console.log("🎉 Import xong!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Import thất bại:", err);
    process.exit(1);
  }
}

importBooks();
