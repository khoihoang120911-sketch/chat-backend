import fs from "fs";
import xlsx from "xlsx";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

// Kết nối database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importBooks() {
  try {
    if (!fs.existsSync("books.xlsx")) {
      console.error("❌ Không tìm thấy file books.xlsx trong repo!");
      process.exit(1);
    }

    // Đọc Excel
    const workbook = xlsx.readFile("books.xlsx");
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    console.log(`📖 Đang import ${data.length} sách từ file Excel...\n`);

    for (let row of data) {
      // In ra để debug
      console.log("👉 Row đọc được:", row);

      // Map cột tiếng Việt
      const title = row["Tên sách"] || row["title"];
      const author = row["Tác giả"] || row["author"];
      const category = row["Thể loại"] || row["category"];
      const location = row["Vị trí"] || row["location"];

      if (!title || !author) {
        console.warn("⚠️ Bỏ qua vì thiếu dữ liệu:", row);
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO books (name, author, category, position)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (name, author) DO NOTHING`,
          [title, author, category, location]
        );
        console.log(`✅ Đã thêm: ${title} (${author})`);
      } catch (err) {
        console.error(`❌ Lỗi khi thêm sách "${title}":`, err.message);
      }
    }

    console.log("\n🎉 Import xong!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Import thất bại:", err);
    process.exit(1);
  }
}

importBooks();
