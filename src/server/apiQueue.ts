/**
 * 外部 API 请求队列 - 控制并发，避免 429
 */
import PQueue from 'p-queue';

const embeddingQueue = new PQueue({
  concurrency: 3,
  interval: 1000,
  intervalCap: 5
});

const chatQueue = new PQueue({
  concurrency: 2,
  interval: 1000,
  intervalCap: 3
});

export async function queueEmbedding<T>(fn: () => Promise<T>): Promise<T> {
  return embeddingQueue.add(fn);
}

export async function queueChat<T>(fn: () => Promise<T>): Promise<T> {
  return chatQueue.add(fn);
}
