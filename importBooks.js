import pkg from "pg";
import dotenv from "dotenv";
import xlsx from "xlsx";

dotenv.config();

// PostgreSQL setup
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
    const rows = xlsx.utils.sheet_to_json(sheet);

    console.log(`📖 Đang import ${rows.length} sách từ Excel...`);

    // Xóa toàn bộ dữ liệu cũ
    await pool.query("TRUNCATE TABLE books RESTART IDENTITY CASCADE");
    console.log("🗑️ Đã xoá sạch dữ liệu cũ trong bảng books.");

    // Import từng dòng
    for (const row of rows) {
      const name = row["Tên sách"];
      const author = row["Tác giả"];
      const category = row["Thể loại"];
      const position = row["Vị trí"];

      if (!name || !author || !category || !position) {
        console.warn("⚠️ Bỏ qua vì thiếu dữ liệu:", row);
        continue;
      }

      await pool.query(
        "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
        [name, author, category, position]
      );
      console.log(`✅ Đã thêm sách: ${name} (${author})`);
    }

    console.log("🎉 Import thành công!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Lỗi khi import:", err);
    process.exit(1);
  }
}

importBooks();
