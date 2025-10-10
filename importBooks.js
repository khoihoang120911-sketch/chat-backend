// importBooks.js
import fs from "fs";
import xlsx from "xlsx";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

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

    const workbook = xlsx.readFile("books.xlsx");
    const sheetName = workbook.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    console.log(`📖 Đang import ${rows.length} dòng từ books.xlsx...`);

    for (const row of rows) {
      // Hiển thị row để debug (bạn sẽ thấy log trên Render)
      console.log("👉 Row đọc được:", row);

      const title = row["Tên sách"] || row["title"] || row["Name"] || row["name"];
      const author = row["Tác giả"] || row["author"] || row["Author"];
      const category = row["Thể loại"] || row["category"] || row["Category"] || null;
      const position = row["Vị trí"] || row["position"] || row["Vị trí sách"] || null;

      if (!title || !author) {
        console.warn("⚠️ Bỏ qua vì thiếu tên sách hoặc tác giả:", row);
        continue;
      }

      try {
        // Kiểm tra tồn tại
        const exists = await pool.query(
          "SELECT id FROM books WHERE name = $1 AND author = $2 LIMIT 1",
          [title, author]
        );
        if (exists.rowCount > 0) {
          // update nếu muốn cập nhật thông tin (category/position)
          await pool.query(
            `UPDATE books SET category = COALESCE($3, category), position = COALESCE($4, position) WHERE id = $5`,
            [category, position, category, position, exists.rows[0].id]
          );
          console.log(`♻️ Đã cập nhật (đã tồn tại): ${title} (${author})`);
        } else {
          await pool.query(
            `INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)`,
            [title, author, category, position]
          );
          console.log(`✅ Đã thêm: ${title} (${author})`);
        }
      } catch (err) {
        console.error(`❌ Lỗi khi xử lý "${title}":`, err.message);
      }
    }

    console.log("🎉 ImportBooks hoàn tất!");
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("❌ Lỗi importBooks:", err);
    await pool.end();
    process.exit(1);
  }
}

importBooks();
