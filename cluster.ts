/**
 * Cluster 模式入口：多进程负载均衡
 * 用法：npm run start:cluster
 */
import cluster from 'cluster';
import os from 'os';

if (cluster.isPrimary) {
  const numWorkers = Math.max(1, parseInt(process.env.WORKERS || String(os.cpus().length), 10));
  console.log(`[Cluster] Primary ${process.pid}, forking ${numWorkers} workers`);
  for (let i = 0; i < numWorkers; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.log(`[Cluster] Worker ${worker.process.pid} exited (${code}), restarting`);
    cluster.fork();
  });
} else {
  process.env.WORKER_ID = String(cluster.worker?.id ?? 0);
  await import('./server');
}
