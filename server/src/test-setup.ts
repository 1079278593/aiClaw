/**
 * Global test setup
 * This file is loaded before all tests to set up the test environment
 */

import path from "node:path";

// Set a default test data directory for all tests
// Individual test files can override this by calling setupTestDir()
process.env.AICLAW_DATA_DIR = path.join(process.cwd(), ".test-data", "global-test");
