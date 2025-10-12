// server.js (final: natural chat + recap fix + full context)
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

// ===== path helpers =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Postgres setup =====
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== Gemini setup =====
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== init tables =====
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT NOT NULL,
      category TEXT,
      position TEXT,
      created_at TIMESTAMP DEFAULT NOW()
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
}
await initTables();

// seed if needed (keeps behavior you used before)
import("./seedBooks.js").catch(()=>{/* ignore if missing */});

// ===== helpers =====
function extractFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

async function assignPosition(category) {
  if (!category) return "X?";
  const letter = category.trim()[0]?.toUpperCase() || "X";
  const res = await pool.query("SELECT COUNT(*) FROM books WHERE category = $1", [category]);
  const count = parseInt(res.rows[0].count || "0", 10);
  const shelf = Math.floor(count / 15) + 1;
  return `${letter}${shelf}`;
}

async function inferCategory(bookName, author) {
  const lower = bookName.toLowerCase();

  // ===== 1️⃣ Tự động nhận dạng theo từ khóa (chạy cực nhanh, không gọi API) =====
  if (/(lịch sử|history|sử ký|cách mạng|chiến tranh|revolution|empire)/i.test(lower)) return "Lịch sử";
  if (/(python|lập trình|code|js|java|react|data|ai|machine|khoa học máy tính|dev)/i.test(lower)) return "Công nghệ";
  if (/(tâm lý|đắc nhân tâm|thói quen|hành vi|động lực|phát triển bản thân|self-help|self help|motivation)/i.test(lower)) return "Tâm lý";
  if (/(kinh tế|đầu tư|tài chính|money|economics|business|market)/i.test(lower)) return "Kinh tế";
  if (/(văn học|tiểu thuyết|thơ|truyện|novel|story|poem|ký)/i.test(lower)) return "Văn học";
  if (/(triết học|philosophy|đạo đức|chính trị|tư tưởng)/i.test(lower)) return "Triết học";
  if (/(giáo dục|education|học tập|sư phạm)/i.test(lower)) return "Giáo dục";
  if (/(y học|medicine|bệnh|sức khỏe|health|chăm sóc)/i.test(lower)) return "Y học";

  // ===== 2️⃣ Nếu không chắc, hỏi Gemini để dự đoán =====
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
Xác định thể loại sách phù hợp nhất (chỉ một từ) trong các loại sau:
["Văn học","Lịch sử","Tâm lý","Công nghệ","Kinh tế","Triết học","Giáo dục","Y học","Chính trị","Khác"]

Tên sách: "${bookName}"
Tác giả: "${author}"

Chỉ trả về JSON dạng:
{"category":"<Tên thể loại>"}
`;
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed?.category || "Khác";
  } catch (e) {
    console.error("⚠️ inferCategory error:", e);
    return "Khác";
  }
}


async function askGeminiToChoose(message, books, conversationContext = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là trợ lý thư viện. Dựa trên đoạn hội thoại gần đây:
${conversationContext}

Người dùng vừa nói: "${message}"

Danh sách sách: ${JSON.stringify(books, null, 2)}

Trả về JSON duy nhất:
{
 "title": "Tên sách EXACT từ DB",
 "author": "Tác giả EXACT từ DB",
 "category": "Thể loại EXACT từ DB",
 "location": "Vị trí EXACT từ DB",
 "reason": "Giải thích ngắn (1-2 câu)"
}
`;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch {
    return null;
  }
}

async function askGeminiForRecap(bookTitle, author) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
Bạn là một trợ lý tóm tắt sách chuyên nghiệp.
Tóm tắt ngắn (100-200 từ) nội dung, chủ đề và đối tượng người đọc của cuốn:
- Tên: "${bookTitle}"
- Tác giả: "${author}"

Trả về JSON duy nhất:
{"title":"${bookTitle}", "author":"${author}", "recap":"Tóm tắt ngắn gọn không quá 200 từ"}
`;

  try {
    const response = await model.generateContent(prompt);
    const raw = response.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch {
    return null;
  }
}

// NEW: chat tự nhiên với Gemini nếu không liên quan đến sách
async function chatWithGeminiFreeform(message, context = "") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `
Bạn là trợ lý AI thân thiện, thông minh. 
Ngữ cảnh trước đó:
${context}

Người dùng: "${message}"

Hãy trả lời tự nhiên, ngắn gọn, dễ hiểu (bằng tiếng Việt).
`;

  try {
    const response = await model.generateContent(prompt);
    return response.response.text();
  } catch (e) {
    return "⚠️ Xin lỗi, mình chưa thể phản hồi lúc này.";
  }
}

// ===== Serve index.html =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== /chat endpoint =====
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Thiếu 'message'" });

  try {
    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["user", message]);
    let reply = "";
    const lower = message.toLowerCase();

    // ADD BOOK
    if (lower.startsWith("add book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: add book: bn: Tên sách; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const category = await inferCategory(bookName, author);
        const position = await assignPosition(category);
        await pool.query(
          "INSERT INTO books (name, author, category, position) VALUES ($1,$2,$3,$4)",
          [bookName, author, category, position]
        );
        reply = `✅ Đã thêm sách: "${bookName}" (${author})\nThể loại: ${category}\nVị trí: ${position}`;
      }
    }

    // DELETE BOOK
    else if (lower.startsWith("delete book")) {
      const match = message.match(/bn:\s*([^;]+);\s*at:\s*(.+)/i);
      if (!match) reply = "❌ Sai cú pháp. Dùng: delete book: bn: Tên sách; at: Tác giả";
      else {
        const bookName = match[1].trim();
        const author = match[2].trim();
        const result = await pool.query("DELETE FROM books WHERE name=$1 AND author=$2 RETURNING *", [bookName, author]);
        reply = result.rowCount ? `🗑️ Đã xoá sách "${bookName}" của ${author}` : `⚠️ Không tìm thấy sách "${bookName}" của ${author}`;
      }
    }

    // VỊ TRÍ
    else if (/\bvị trí\s+[A-Z]\d+\b/i.test(lower)) {
      const m = lower.match(/\bvị trí\s+([A-Z]\d+)\b/i);
      const pos = m ? m[1].toUpperCase() : null;
      if (!pos) reply = "⚠️ Hãy nhập vị trí theo dạng ví dụ: 'vị trí B2 là quyển gì'";
      else {
        const { rows } = await pool.query("SELECT name, author, category FROM books WHERE position=$1 LIMIT 1", [pos]);
        reply = rows.length
          ? `📚 Ở vị trí ${pos}: "${rows[0].name}" (${rows[0].author})\nThể loại: ${rows[0].category || "Chưa rõ"}`
          : `📭 Không có sách ở vị trí ${pos}.`;
      }
    }

    // RECAP (fix)
    else if (/\b(tóm tắt|recap|summary)\b/i.test(lower)) {
      let guess = message.replace(/["'‘’“”]/g, "").toLowerCase();
      guess = guess.replace(/\b(recape?|tóm tắt|summary|giúp|cuốn|sách|hãy|nội dung|cho tôi|về|đi)\b/g, "").trim();

      let target = null;
      const q = await pool.query(
        `SELECT name, author, category, position FROM books 
         WHERE LOWER(name) LIKE $1 OR LOWER(author) LIKE $1 LIMIT 1`,
        [`%${guess}%`]
      );
      if (q.rows.length) target = q.rows[0];

      if (!target) {
        const all = await pool.query("SELECT name, author, category, position FROM books");
        for (const b of all.rows) {
          if (message.toLowerCase().includes(b.name.toLowerCase())) { target = b; break; }
        }
      }

      if (!target) reply = "⚠️ Mình chưa rõ bạn muốn tóm tắt quyển nào. Hãy nói tên sách cụ thể nhé.";
      else {
        const recap = await askGeminiForRecap(target.name, target.author);
        reply = recap?.recap
          ? `📖 "${target.name}" (${target.author})\nThể loại: ${target.category || "Chưa rõ"}, Vị trí: ${target.position}\n\n📝 ${recap.recap}`
          : `⚠️ Không tóm tắt được lúc này.`;
      }
    }

    // SEARCH or CHAT
    else {
      const { rows: books } = await pool.query("SELECT name, author, category, position FROM books");
      const histRes = await pool.query("SELECT role, message FROM conversations ORDER BY id DESC LIMIT 6");
      const recent = histRes.rows.reverse().map(r => `${r.role === "user" ? "Người dùng" : "Trợ lý"}: ${r.message}`).join("\n");

      const keywords = message.toLowerCase();
      const directMatch = books.filter(b =>
        (b.name && b.name.toLowerCase().includes(keywords)) ||
        (b.author && b.author.toLowerCase().includes(keywords)) ||
        (b.category && b.category.toLowerCase().includes(keywords))
      );

      // nếu không có sách liên quan -> chat tự nhiên
      if (!books.length || (!directMatch.length && /thời tiết|tâm trạng|ai là|là gì|tại sao|như thế nào|bao nhiêu|ở đâu|ai viết/i.test(message))) {
        reply = await chatWithGeminiFreeform(message, recent);
      } else {
        let chosen = null;
        if (directMatch.length === 1) {
          chosen = directMatch[0];
          reply = `📚 Gợi ý: "${chosen.name}" (${chosen.author})\nThể loại: ${chosen.category || "Chưa rõ"}, Vị trí: ${chosen.position}`;
        } else {
          const pick = await askGeminiToChoose(message, directMatch.length ? directMatch : books, recent);
          if (pick && pick.title) {
            const rec = (directMatch.length ? directMatch : books).find(b => b.name === pick.title) || books[0];
            reply = `📚 Gợi ý: "${rec.name}" (${rec.author})\nThể loại: ${rec.category || "Chưa rõ"}, Vị trí: ${rec.position}\n💡 ${pick.reason || ""}`;
          } else {
            reply = await chatWithGeminiFreeform(message, recent);
          }
        }
      }
    }

    await pool.query("INSERT INTO conversations (role, message) VALUES ($1, $2)", ["assistant", reply]);
    res.json({ reply });
  } catch (err) {
    console.error("❌ Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

//cc
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy trên cổng ${PORT}`));
