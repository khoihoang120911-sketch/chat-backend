// server.js (final: natural chat + recap fix + full context + valid Gemini API)
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

// seed if needed
import("./seedBooks.js").catch(()=>{/* ignore if missing */});

// ===== helpers =====
function extractFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
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
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ type: "google_search_retrieval" }] // Cho phép Gemini tra web khi cần
  });

  // Danh mục cố định của thư viện
  const allowedCategories = [
    "Văn học",
    "Lịch sử",
    "Công nghệ",
    "Khoa học",
    "Tâm lý",
    "Giáo dục",
    "Kinh tế",
    "Văn hoá",
    "Chính trị",
    "Thiếu nhi",
    "Tôn giáo",
    "Xã hội"
  ];

  const prompt = `
Bạn là thủ thư thông minh của thư viện.
Dựa vào thông tin có thể tìm thấy trên web nếu cần, hãy xác định thể loại phù hợp nhất cho cuốn sách.
Phải chọn một trong các thể loại sau: ${allowedCategories.join(", ")}.

Tên sách: "${bookName}"
Tác giả: "${author}"

Trả về đúng một JSON duy nhất: {"category": "Thể loại từ danh sách trên"}
Nếu không chắc chắn, trả {"category": "Chưa rõ"}.
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const raw = result.response.text();
    const parsed = extractFirstJson(raw);

    // Nếu Gemini trả về hợp lệ và khớp danh sách
    if (parsed && parsed.category) {
      const found = allowedCategories.find(c =>
        parsed.category.toLowerCase().includes(c.toLowerCase())
      );
      if (found) return found;
      if (parsed.category.toLowerCase().includes("chưa rõ")) return "Chưa rõ";
    }

    // Nếu không có hoặc không hợp lệ → fallback tự suy luận
    const titleLower = bookName.toLowerCase();
    if (/(python|program|code|data|ai|machine|kỹ thuật|công nghệ)/i.test(titleLower)) return "Công nghệ";
    if (/(lịch sử|history|war|chiến tranh|đặng thùy trâm|trần hưng đạo)/i.test(titleLower)) return "Lịch sử";
    if (/(tiểu thuyết|truyện|novel|ký|thơ|văn học|poem|fiction)/i.test(titleLower)) return "Văn học";
    if (/(tâm lý|psychology|cảm xúc|hành vi)/i.test(titleLower)) return "Tâm lý";
    if (/(giáo dục|education|học tập)/i.test(titleLower)) return "Giáo dục";
    if (/(kinh tế|economy|business|thương mại)/i.test(titleLower)) return "Kinh tế";
    if (/(chính trị|politic|xã hội|culture|văn hoá|religion|tôn giáo|society)/i.test(titleLower)) return "Xã hội";
    return "Chưa rõ";
  } catch (e) {
    console.error("⚠️ inferCategory error:", e);
    return "Chưa rõ";
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
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch (e) {
    console.error("⚠️ askGeminiToChoose error:", e);
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
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const raw = result.response.text();
    const parsed = extractFirstJson(raw);
    return parsed;
  } catch (e) {
    console.error("⚠️ askGeminiForRecap error:", e);
    return null;
  }
}

// ===== Chat tự nhiên có tra web =====
async function chatWithGeminiFreeform(message, context = "") {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ type: "google_search_retrieval" }]
  });

  const prompt = `
Bạn là trợ lý AI thân thiện, thông minh, có thể tra cứu thông tin trên web khi cần.
Ngữ cảnh trước đó:
${context}

Người dùng: "${message}"

Hãy trả lời tự nhiên, dễ hiểu (bằng tiếng Việt), sử dụng thông tin chính xác nếu cần tra web.
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    const text = result.response.text();
    return text || "⚠️ Không có phản hồi từ Gemini.";
  } catch (e) {
    console.error("⚠️ chatWithGeminiFreeform error:", e);
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

    // RECAP
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

    // SEARCH hoặc CHAT tự nhiên
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

      if (!books.length || (!directMatch.length && /thời tiết|ai là|là gì|ở đâu|bao nhiêu|tại sao|như thế nào/i.test(message))) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server đang chạy trên cổng ${PORT}`));
