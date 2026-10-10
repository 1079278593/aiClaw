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
 * Cleanup a test data directory
 *
 * @param testDir - The test directory path to cleanup
 */
export async function cleanupTestDir(testDir: string): Promise<void> {
  await rm(testDir, { recursive: true, force: true });
}
