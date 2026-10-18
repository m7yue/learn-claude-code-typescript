import { embedText } from "../../runtime/embedding.ts";

/**
 * RAG（检索增强生成）最小实现 —— 教学用。
 *
 * 完整流程（四步）：
 *   1. 把每段文档变成向量：数「关键词清单」里每个词出现几次
 *   2. 把查询也变成向量（用同一张关键词清单，顺序也一致）
 *   3. 用余弦相似度，算「查询向量」和「每个文档向量」有多接近
 *   4. 按分数从高到低排序，取最相关的几个
 *
 * 运行：node --import tsx src/modules/rag.ts
 */

// ------------------------------------------------------------
// 余弦相似度：两个向量「方向有多一致」。通用范围是 -1..1（1 同向 / 0 垂直 / -1 反向），
// 但这里的向量都是「出现次数」（每个数 ≥ 0），夹角最多到 90°，所以实际落在 0..1，不会出现负数。
// 公式：点积 ÷ (长度A × 长度B)
//   - 点积 = 对应位置相乘，再加起来
//   - 长度 = 每个数的平方，加起来，再开根号（勾股定理）
// ------------------------------------------------------------
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let lenA = 0;
  let lenB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    lenA += a[i] * a[i];
    lenB += b[i] * b[i];
  }
  if (lenA === 0 || lenB === 0) return 0;
  return dot / (Math.sqrt(lenA) * Math.sqrt(lenB));
}

// ------------------------------------------------------------
// 把文字变成向量：按关键词清单的顺序，数每个关键词出现几次。
// 例：keywords = ["向量", "数据库"]，text = "向量数据库" → [1, 1]
// 注意：是按「字面」匹配，所以同义词（如 "TS" 与 "TypeScript"）认不出来。
// ------------------------------------------------------------
export function countKeywords(text: string, keywords: string[]): number[] {
  return keywords.map((word) => {
    let count = 0;
    let from = 0;
    while (true) {
      const index = text.indexOf(word, from);
      if (index === -1) break;
      count += 1;
      from = index + word.length;
    }
    return count;
  });
}

// ------------------------------------------------------------
// 检索：对每个文档算余弦相似度，排序，取前 topK 个。
// ------------------------------------------------------------
export interface RankedDocument {
  text: string;
  score: number;
}

export function rankDocuments(
  query: string,
  documents: string[],
  keywords: string[],
  topK = 3,
): RankedDocument[] {
  const queryVec = countKeywords(query, keywords);
  return documents
    .map((text) => ({
      text,
      score: cosineSimilarity(queryVec, countKeywords(text, keywords)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ------------------------------------------------------------
// 真实语义检索（结构占位）：
// 文档和查询都用同一个 embedding 模型（embedText）生成向量，再算余弦相似度。
// mock 模式下 embedText 返回占位向量，结果没有真实语义；
// 填好 EMBEDDING_* 三个变量并用 --real 运行后，即为真实语义检索。
// ------------------------------------------------------------
export async function rankDocumentsByEmbedding(
  query: string,
  documents: string[],
  topK = 3,
): Promise<RankedDocument[]> {
  const queryVec = await embedText(query);
  const ranked: RankedDocument[] = [];
  for (const text of documents) {
    ranked.push({ text, score: cosineSimilarity(queryVec, await embedText(text)) });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ------------------------------------------------------------
// 演示：用 .memory/ 里真实的记忆内容当「文档」。
// ------------------------------------------------------------
const KEYWORDS = ["TypeScript", "记忆", "Tab", "中文", "代数效应"];

const MEMORY_DOCS = [
  // .memory/project-facts.md
  "TypeScript 教学仓库；默认 mock 离线；记忆落在 .memory/。",
  // .memory/agent-conventions.md
  "保持代数效应 + 生成器写法；当前请求优先于记忆。",
  // .memory/user-preferences.md
  "偏好 Tab 缩进、中文交流。",
];

function show(query: string) {
  console.log(`\n查询：${query}`);
  const results = rankDocuments(query, MEMORY_DOCS, KEYWORDS, 3).filter((r) => r.score > 0);
  if (results.length === 0) {
    console.log("  （所有文档分数都是 0：没搜到）");
    return;
  }
  for (const r of results) {
    console.log(`  [${r.score.toFixed(3)}] ${r.text}`);
  }
}

console.log("关键词清单：", KEYWORDS.join("、"));
console.log("\n=== 现象 1：查询里含关键词，能搜到 ===");
show("这个仓库是用 TypeScript 写的吗");

console.log("\n=== 现象 2：换个说法（不含关键词），就搜不到 ===");
show("这个项目是用什么编程语言写的");

console.log("\n=== 现象 3：查询含多个关键词，精确命中 ===");
show("用户偏好 Tab 和中文");
