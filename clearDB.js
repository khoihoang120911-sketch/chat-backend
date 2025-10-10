// clearDB.js
import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function clearDB() {
  try {
    console.log("🗑️ Đang xóa toàn bộ dữ liệu trong bảng books và conversations...");
    await pool.query("TRUNCATE TABLE books RESTART IDENTITY CASCADE");
    await pool.query("TRUNCATE TABLE conversations RESTART IDENTITY CASCADE");
    console.log("✅ Đã xóa sạch dữ liệu!");
  } catch (err) {
    console.error("❌ Lỗi khi xóa DB:", err);
  } finally {
    await pool.end();
  }
}

clearDB();
