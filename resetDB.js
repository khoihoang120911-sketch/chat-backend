// resetDB.js
import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const fixedBooks = [
  { name: "Lập trình Python cơ bản", author: "Nguyễn Thanh Tùng", category: "Công nghệ", position: "A1" },
  { name: "Trí tuệ nhân tạo", author: "Stuart Russell & Peter Norvig", category: "Công nghệ", position: "A2" },
  { name: "Khoa học dữ liệu với Python", author: "Wes McKinney", category: "Công nghệ", position: "A3" },
  { name: "Truyện Kiều", author: "Nguyễn Du", category: "Văn học", position: "B1" },
  { name: "Nhật ký trong tù", author: "Hồ Chí Minh", category: "Văn học", position: "B2" },
  { name: "Chiến tranh và hoà bình", author: "Lev Tolstoy", category: "Văn học", position: "B3" },
  { name: "Đắc nhân tâm", author: "Dale Carnegie", category: "Tâm lý", position: "C1" },
  { name: "Tư bản", author: "Karl Marx", category: "Kinh tế", position: "D1" },
  { name: "Nguồn gốc các loài", author: "Charles Darwin", category: "Khoa học", position: "E1" },
  { name: "Lược sử thời gian", author: "Stephen Hawking", category: "Khoa học", position: "E2" },
  { name: "Sapiens: Lược sử loài người", author: "Yuval Noah Harari", category: "Lịch sử", position: "F1" },
  { name: "Nhà giả kim", author: "Paulo Coelho", category: "Văn học", position: "B4" },
  { name: "Phân tích tâm lý học", author: "Sigmund Freud", category: "Tâm lý", position: "C2" },
  { name: "Kinh tế học vĩ mô", author: "N. Gregory Mankiw", category: "Kinh tế", position: "D2" },
  { name: "Các cuộc cách mạng thế giới", author: "Christopher Hill", category: "Lịch sử", position: "F2" }
];

async function resetDB() {
  try {
    console.log("🗑️ TRUNCATE bảng books...");
    await pool.query("TRUNCATE TABLE books RESTART IDENTITY CASCADE");

    console.log("📥 Nạp dữ liệu gốc...");
    for (const book of fixedBooks) {
      await pool.query(
        "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
        [book.name, book.author, book.category, book.position]
      );
      console.log(`✅ Đã thêm: ${book.name} (${book.author})`);
    }

    console.log("🎉 Reset DB thành công!");
  } catch (err) {
    console.error("❌ Lỗi reset:", err);
  } finally {
    await pool.end();
  }
}

resetDB();
