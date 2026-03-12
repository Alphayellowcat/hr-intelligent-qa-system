/**
 * 本地向量存储模块 - 基于 LanceDB
 * 支持增量索引：仅对新增/变更的 chunk 进行 embedding，删除已移除的 chunk
 */
import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import crypto from 'crypto';

const LANCE_DIR = path.join(process.cwd(), '.lancedb');
const TABLE_NAME = 'kb_vectors';

export interface ChunkInput {
  filePath: string;
  text: string;
  chunkIndex: number;
}

export interface ChunkRecord extends ChunkInput {
  id: string;
  contentHash: string;
  vector: number[];
}

function chunkId(filePath: string, chunkIndex: number): string {
  return `${filePath}#${chunkIndex}`;
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

let db: lancedb.Connection | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!db) {
    db = await lancedb.connect(LANCE_DIR);
  }
  return db;
}

/** 获取 embedding 模型向量维度（bge-m3 为 1024） */
function getVectorDimension(): number {
  return 1024;
}

/** 提取知识库 chunks，与 Chat 中的分块逻辑一致 */
export function extractChunks(tree: { folder: string; files: { key: string; name: string; content: string }[] }[]): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  for (const folder of tree) {
    for (const file of folder.files) {
      const filePath = `/${folder.folder}/${file.name}`;
      const paragraphs = file.content.split('\n\n').filter((p: string) => p.trim().length > 20);
      paragraphs.forEach((p: string, idx: number) => {
        chunks.push({
          filePath,
          text: p.trim(),
          chunkIndex: idx
        });
      });
    }
  }
  return chunks;
}

/** 计算当前 chunks 与已索引的差异，返回需添加、需删除 */
function diffChunks(
  current: ChunkInput[],
  existing: Map<string, string> // chunk_id -> content_hash
): { toAdd: ChunkInput[]; toDelete: string[] } {
  const currentMap = new Map<string, string>();
  for (const c of current) {
    const id = chunkId(c.filePath, c.chunkIndex);
    currentMap.set(id, contentHash(c.text));
  }

  const toAdd: ChunkInput[] = [];
  const toDelete: string[] = [];

  for (const c of current) {
    const id = chunkId(c.filePath, c.chunkIndex);
    const hash = currentMap.get(id)!;
    const existingHash = existing.get(id);
    if (!existingHash || existingHash !== hash) {
      toAdd.push(c);
    }
  }
  for (const id of existing.keys()) {
    const curHash = currentMap.get(id);
    if (!curHash) {
      toDelete.push(id); // 已从知识库移除
    } else if (curHash !== existing.get(id)) {
      toDelete.push(id); // 内容变更，需先删后增
    }
  }
  return { toAdd, toDelete };
}

/** 获取表中现有 chunk 的 id 和 hash（用于增量 diff） */
async function getExistingChunkHashes(): Promise<Map<string, string>> {
  const connection = await getDb();
  const tableNames = await connection.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return new Map();
  }
  const table = await connection.openTable(TABLE_NAME);
  const rows = await table.query().select(['id', 'content_hash']).toArray();
  const map = new Map<string, string>();
  for (const r of rows as { id: string; content_hash: string }[]) {
    map.set(r.id, r.content_hash);
  }
  return map;
}

/** 调用 embedding API 生成向量 */
async function embedTexts(
  texts: string[],
  embedFn: (texts: string[]) => Promise<number[][]>
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const BATCH_SIZE = 20;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors = await embedFn(batch);
    results.push(...vectors);
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, 500)); // 避免 API 限流
    }
  }
  return results;
}

export interface IndexOptions {
  embedFn: (texts: string[]) => Promise<number[][]>;
  onProgress?: (message: string) => void;
}

export interface IndexResult {
  added: number;
  deleted: number;
  skipped: number;
  totalChunks: number;
}

/** 增量索引：仅处理变更的 chunks */
export async function indexKnowledge(
  tree: { folder: string; files: { key: string; name: string; content: string }[] }[],
  options: IndexOptions
): Promise<IndexResult> {
  const connection = await getDb();
  const chunks = extractChunks(tree);
  const existing = await getExistingChunkHashes();
  const { toAdd, toDelete } = diffChunks(chunks, existing);

  const onProgress = options.onProgress || (() => {});

  let added = 0;
  let deleted = 0;

  // 删除已移除的 chunks
  if (toDelete.length > 0) {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      const table = await connection.openTable(TABLE_NAME);
      const escaped = toDelete.map(id => `'${String(id).replace(/'/g, "''")}'`);
      if (escaped.length <= 50) {
        await table.delete(`id IN (${escaped.join(',')})`);
      } else {
        for (let i = 0; i < escaped.length; i += 50) {
          const batch = escaped.slice(i, i + 50);
          await table.delete(`id IN (${batch.join(',')})`);
        }
      }
      deleted = toDelete.length;
      onProgress(`已移除 ${deleted} 个过期段落`);
    }
  }

  // 对新增/变更的 chunks 做 embedding 并写入
  if (toAdd.length > 0) {
    onProgress(`正在为 ${toAdd.length} 个段落生成向量...`);
    const texts = toAdd.map(c => c.text);
    const vectors = await embedTexts(texts, options.embedFn);

    const rows: Record<string, unknown>[] = toAdd.map((c, i) => ({
      id: chunkId(c.filePath, c.chunkIndex),
      file_path: c.filePath,
      text: c.text,
      content_hash: contentHash(c.text),
      vector: vectors[i] || new Array(getVectorDimension()).fill(0)
    }));

    if (await connection.tableNames().then(n => n.includes(TABLE_NAME))) {
      const table = await connection.openTable(TABLE_NAME);
      await table.add(rows);
    } else {
      await connection.createTable(TABLE_NAME, rows);
    }
    added = toAdd.length;
    onProgress(`已索引 ${added} 个新段落`);
  }

  const skipped = chunks.length - toAdd.length - toDelete.length;
  if (skipped > 0) {
    onProgress(`跳过 ${skipped} 个未变更段落`);
  }

  return {
    added,
    deleted,
    skipped,
    totalChunks: chunks.length
  };
}

export interface SearchResult {
  filePath: string;
  snippet: string;
  similarityScore: string;
}

/** 向量相似度搜索 */
export async function vectorSearch(
  queryVector: number[],
  limit: number = 5
): Promise<SearchResult[]> {
  const connection = await getDb();
  const tableNames = await connection.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return [];
  }
  const table = await connection.openTable(TABLE_NAME);
  const results = await table
    .query()
    .nearestTo(queryVector)
    .distanceType('cosine')
    .limit(limit)
    .toArray();

  return (results as { file_path: string; text: string; _distance?: number }[]).map(r => ({
    filePath: r.file_path,
    snippet: r.text,
    similarityScore: r._distance != null ? (1 - r._distance).toFixed(3) : ''
  }));
}

/** 获取索引状态 */
export async function getIndexStatus(): Promise<{
  tableExists: boolean;
  chunkCount: number;
}> {
  const connection = await getDb();
  const tableNames = await connection.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return { tableExists: false, chunkCount: 0 };
  }
  const table = await connection.openTable(TABLE_NAME);
  const count = await table.countRows();
  return { tableExists: true, chunkCount: count };
}
