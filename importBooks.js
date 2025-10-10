import pkg from "pg";
import xlsx from "xlsx";
import dotenv from "dotenv";

dotenv.config();

// ===== PostgreSQL setup =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importBooks() {
  try {
    // Đọc file Excel
    const workbook = xlsx.readFile("books.xlsx");
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const books = xlsx.utils.sheet_to_json(sheet);

    console.log(`📖 Đang import ${books.length} sách...`);

    for (let book of books) {
      const { name, author, category, position } = book;

      if (!name || !author) {
        console.log("⚠️ Bỏ qua vì thiếu dữ liệu:", book);
        continue;
      }

      await pool.query(
        `INSERT INTO books (name, author, category, position) 
         VALUES ($1, $2, $3, $4)`,
        [name, author, category || null, position || null]
      );
      console.log(`✅ Đã thêm: ${name} (${author})`);
    }

    console.log("🎉 Import thành công!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Lỗi khi import:", err);
    process.exit(1);
  }
}

importBooks();
