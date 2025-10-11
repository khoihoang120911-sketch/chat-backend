// server.js (final ready)
import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// === init tables ===
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      category TEXT,
      position TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
await initTables();
import("./seedBooks.js").catch(() => {});

// === helpers ===
function extractFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

const VALID_CATEGORIES = [
  "Công nghệ", "Văn học", "Lịch sử", "Kinh tế",
  "Tâm lý", "Giáo dục", "Chính trị", "Chưa rõ"
];

function normalizeCategory(input) {
  if (!input) return "Chưa rõ";
  const t = input.toLowerCase();
  if (/(tech|code|ai|data|lập trình|máy tính)/.test(t)) return "Công nghệ";
  if (/(truyện|tiểu thuyết|văn học|ký|novel)/.test(t)) return "Văn học";
  if (/(lịch sử|chiến tranh|history|war)/.test(t)) return "Lịch sử";
  if (/(kinh tế|tài chính|business|economy)/.test(t)) return "Kinh tế";
  if (/(tâm lý|psychology)/.test(t)) return "Tâm lý";
  if (/(giáo dục|education)/.test(t)) return "Giáo dục";
  if (/(chính trị|politic)/.test(t)) return "Chính trị";
  return "Chưa rõ";
}

async function assignPosition(category) {
  const c = normalizeCategory(category);
  const letter = c[0].toUpperCase();
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category=$1", [c]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

// === Gemini functions ===
async function detectIntent(message) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Phân loại câu sau thành 1 loại duy nhất:
- add_book
- delete_book
- ask_recap
- search_book
- recommend_book
- smalltalk
- other
Trả về JSON {"intent":"..."}
Câu: "${message}"
`;
  try {
    const r = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const raw = r.response.text();
    return extractFirstJson(raw)?.intent || "other";
  } catch (e) {
    console.error("⚠️ detectIntent error:", e);
    return "other";
  }
}

async function inferCategory(name, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Chọn thể loại phù hợp nhất cho "${name}" (${author}) trong:
${VALID_CATEGORIES.join(", ")}.
Trả về JSON {"category":"..."}
`;
  try {
    const r = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    return normalizeCategory(extractFirstJson(r.response.text())?.category);
  } catch {
    return "Chưa rõ";
  }
}

async function askGeminiForRecap(name, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Tóm tắt ngắn (100–200 từ) nội dung, chủ đề và ý nghĩa của "${name}" (${author}).
Trả về JSON {"recap":"..."}
`;
  try {
    const r = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    return extractFirstJson(r.response.text())?.recap || null;
  } catch {
    return null;
  }
}

async function chatWithGeminiFreeform(message, context = "") {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ type: "google_search_retrieval" }],
  });
  const prompt = `
Bạn là trợ lý thân thiện, thông minh, có thể tra cứu thông tin web khi cần.
Ngữ cảnh:
${context}
Người dùng: "${message}"
Trả lời tự nhiên, bằng tiếng Việt.
`;
  try {
    const r = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    return r.response.text() || "⚠️ Không có phản hồi.";
  } catch {
    return "⚠️ Xin lỗi, mình chưa thể phản hồi lúc này.";
  }
}

async function askGeminiToChoose(message, books) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Người dùng nói: "${message}"
Danh sách sách:
${books.map(b => `- ${b.name} (${b.author}) [${b.category}]`).join("\n")}
Hãy chọn duy nhất 1 quyển phù hợp nhất (không bịa).
Trả về JSON {"title":"Tên sách","reason":"Giải thích ngắn"}
`;
  try {
    const r = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    return extractFirstJson(r.response.text());
  } catch (e) {
    console.error("⚠️ askGeminiToChoose error:", e);
    return null;
  }
}

// === ROUTES ===
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu message" });
  try {
    await pool.query("INSERT INTO conversations (role,message) VALUES ($1,$2)", ["user", message]);
    const { rows: books } = await pool.query("SELECT * FROM books");
    const intent = await detectIntent(message);

    const histRes = await pool.query("SELECT role,message FROM conversations ORDER BY id DESC LIMIT 6");
    const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");

    let reply = "";

    // ADD BOOK
    if (intent === "add_book") {
      const m = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!m) reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên; at: Tác giả";
      else {
        const [_, name, author] = m;
        const cat = await inferCategory(name.trim(), author.trim());
        const pos = await assignPosition(cat);
        await pool.query("INSERT INTO books (name,author,category,position) VALUES ($1,$2,$3,$4)", [name.trim(), author.trim(), cat, pos]);
        reply = `✅ Đã thêm "${name.trim()}" (${author.trim()})\nThể loại: ${cat}\nVị trí: ${pos}`;
      }
    }

    // DELETE BOOK
    else if (intent === "delete_book") {
      const m = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!m) reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên; at: Tác giả";
      else {
        const [_, name, author] = m;
        const del = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [name.trim(), author.trim()]);
        reply = del.rowCount ? `🗑️ Đã xoá "${name.trim()}" (${author.trim()})` : "⚠️ Không tìm thấy sách.";
      }
    }

    // ASK RECAP
    else if (intent === "ask_recap") {
      const text = message.toLowerCase();
      const found = books.find(b => text.includes(b.name.toLowerCase()) || text.includes(b.author.toLowerCase()));
      if (!found) reply = "⚠️ Không rõ bạn muốn tóm tắt sách nào.";
      else {
        const recap = await askGeminiForRecap(found.name, found.author);
        reply = recap ? `📖 "${found.name}" (${found.author})\n📝 ${recap}` : "⚠️ Không thể tóm tắt ngay bây giờ.";
      }
    }

    // RECOMMEND BOOK
    else if (intent === "recommend_book" || intent === "search_book") {
      const kw = message.toLowerCase();
      const related = books.filter(b =>
        b.name.toLowerCase().includes(kw) ||
        b.author.toLowerCase().includes(kw) ||
        b.category.toLowerCase().includes(kw)
      );
      if (related.length === 0) reply = "⚠️ Không tìm thấy sách phù hợp trong thư viện.";
      else if (related.length === 1) {
        const b = related[0];
        reply = `📘 "${b.name}" (${b.author}) - ${b.category}, vị trí ${b.position}`;
      } else {
        const pick = await askGeminiToChoose(message, related);
        if (pick && pick.title) {
          const chosen = related.find(b => b.name.toLowerCase() === pick.title.toLowerCase()) || related[0];
          reply = `📘 "${chosen.name}" (${chosen.author}) - ${chosen.category}, vị trí ${chosen.position}\n💡 ${pick.reason || ""}`;
        } else reply = "⚠️ Không tìm thấy sách phù hợp.";
      }
    }

    // DEFAULT CHAT
    else {
      reply = await chatWithGeminiFreeform(message, recent);
    }

    await pool.query("INSERT INTO conversations (role,message) VALUES ($1,$2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy tại cổng ${PORT}`));
