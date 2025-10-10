import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        category TEXT,
        position TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT unique_book UNIQUE (name, author)  -- ✅ thêm constraint
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log("✅ Tables created (with UNIQUE constraint).");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  } finally {
    pool.end();
  }
}

createTables();
