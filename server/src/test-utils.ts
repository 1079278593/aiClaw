/**
 * Test utilities for aiClaw
 */

import { rm, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Setup a test data directory for a test file
 * Creates a unique directory under .test-data/{testName}
 *
 * @param testName - Name of the test (e.g., "config-test", "memory-db-test")
 * @returns The test directory path
 */
export async function setupTestDir(testName: string): Promise<string> {
  const testDir = path.join(process.cwd(), ".test-data", testName);

  // Set environment variable for this test
  process.env.AICLAW_DATA_DIR = testDir;

  // Clean up test directory
  await rm(testDir, { recursive: true, force: true });

  // Recreate test directory
  await mkdir(testDir, { recursive: true });

  return testDir;
}

/**
 * Cleanup a test data directory.
 *
 * 后台任务/websocket 收尾可能仍在创建默认目录，`rm` 偶发 ENOTEMPTY；
 * 这里重试几次，避免把「清理竞态」误报成测试失败。
 */
export async function cleanupTestDir(testDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(testDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await rm(testDir, { recursive: true, force: true });
}
