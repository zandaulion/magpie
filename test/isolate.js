// Loaded into every test process (see the test script). Each file gets its own
// data directory, so files that open the database neither race one another on
// the same SQLite file nor write into the checkout's ./data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-test-'));
  process.env.DATA_DIR = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
