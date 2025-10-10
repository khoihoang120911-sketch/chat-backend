// fixSchema.js
import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  try {
    console.log("🔎 Kiểm tra trùng lặp trong bảng books...");

    const dupRes = await pool.query(`
      SELECT name, author, array_agg(id ORDER BY id) AS ids, COUNT(*) AS cnt
      FROM books
      GROUP BY name, author
      HAVING COUNT(*) > 1
    `);

    if (dupRes.rowCount === 0) {
      console.log("✅ Không có bản ghi trùng lặp.");
    } else {
      console.log(`⚠️ Tìm thấy ${dupRes.rowCount} nhóm trùng lặp. Bắt đầu dedupe...`);
      for (const r of dupRes.rows) {
        const ids = r.ids;
        const keep = ids[0];               // giữ id nhỏ nhất
        const remove = ids.slice(1);       // xoá các id còn lại

        console.log(`→ Giữ id=${keep} cho [${r.name}] (${r.author}), xóa ids: ${remove.join(",")}`);

        await pool.query(
          `DELETE FROM books WHERE id = ANY($1::int[])`,
          [remove]
        );
      }
      console.log("✅ Đã xóa các bản ghi trùng. ");
    }

    // Thêm UNIQUE constraint nếu chưa tồn tại
    console.log("🔧 Thêm UNIQUE constraint (name, author) nếu chưa tồn tại...");
    try {
      await pool.query(`
        ALTER TABLE books
        ADD CONSTRAINT unique_book_name_author UNIQUE (name, author);
      `);
      console.log("✅ UNIQUE constraint đã được thêm.");
    } catch (err) {
      // nếu constraint đã tồn tại, PostgreSQL trả lỗi — catch và tiếp tục
      if (err.code === '23505' || /already exists/i.test(err.message)) {
        console.log("ℹ️ UNIQUE constraint đã tồn tại trước đó.");
      } else {
        console.warn("⚠️ Lỗi khi thêm constraint:", err.message);
      }
    }

    console.log("🎯 fixSchema hoàn tất.");
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("❌ fixSchema lỗi:", err);
    await pool.end();
    process.exit(1);
  }
}

fix();
