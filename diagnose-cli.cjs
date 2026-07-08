/**
 * CLI binary diagnosis utility.
 * Run with: node diagnose-cli.cjs
 * Tests binary detection, execSync behavior, and path handling.
 */
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// --- CONFIG: Edit this to your Obsidian CLI path ---
const BINARY_PATH = 'E:\\Ansh Files\\Installed Softwares\\Obsidian\\Obsidian.com';
// ---

const RESULTS = { pass: 0, fail: 0 };

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    RESULTS.pass++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    RESULTS.fail++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('='.repeat(70));
console.log('CLI Binary Diagnosis');
console.log('='.repeat(70));
console.log(`Path: ${BINARY_PATH}`);
console.log(`Platform: ${process.platform}`);
console.log(`cwd: ${process.cwd()}`);
console.log('');

// --- Section 1: File existence ---
console.log('--- Section 1: File Existence ---');
test('file exists on disk', () => {
  assert(existsSync(BINARY_PATH), 'File not found at path');
});
test('file is not a directory', () => {
  const stat = require('fs').statSync(BINARY_PATH);
  assert(stat.isFile(), 'Path exists but is not a file');
});
test('file has .com extension', () => {
  const ext = path.extname(BINARY_PATH).toLowerCase();
  assert(ext === '.com' || ext === '.exe', `Unexpected extension: "${ext}"`);
});

// --- Section 2: Path quoting ---
console.log('');
console.log('--- Section 2: Quoting Strategies ---');

// Strategy A: quoted path (our current approach)
test('strategy A: execSync with quoted path + "version"', () => {
  const cmd = `"${BINARY_PATH}" version`;
  console.log(`    Raw command: ${cmd}`);
  const result = execSync(cmd, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
  const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
  console.log(`    stdout: "${out}"`);
  assert(out.length > 0, 'Empty output from version command');
});

// Strategy B: unquoted path (no spaces in path would work)
test('strategy B: execSync with unquoted path + "version"', () => {
  const cmd = `${BINARY_PATH} version`;
  console.log(`    Raw command: ${cmd}`);
  try {
    const result = execSync(cmd, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
    const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
    console.log(`    stdout: "${out}"`);
  } catch (e) {
    console.log(`    (expected fail if path has spaces): ${e.message.substring(0, 100)}`);
    throw e;
  }
});

// Strategy C: cmd.exe /c with different wrapping
test('strategy C: execSync with cmd /c + double-quoted path', () => {
  const cmd = `cmd.exe /d /c ""${BINARY_PATH}" version"`;
  console.log(`    Raw command: ${cmd}`);
  const result = execSync(cmd, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
  const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
  console.log(`    stdout: "${out}"`);
  assert(out.length > 0, 'Empty output');
});

// --- Section 3: Command execution ---
console.log('');
console.log('--- Section 3: Actual CLI Commands ---');

// Test a simple query command
test('execSync "version" (without extra args)', () => {
  const cmd = `"${BINARY_PATH}" version`;
  const result = execSync(cmd, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
  const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
  console.log(`    stdout: "${out}"`);
  assert(out.length > 0, 'Empty output');
});

// Test with a simple command (no spaces in args)
test('execSync "vault" command (list vaults)', () => {
  const cmd = `"${BINARY_PATH}" vault`;
  console.log(`    Raw command: ${cmd}`);
  try {
    const result = execSync(cmd, { timeout: 10000, encoding: 'utf-8', windowsHide: true });
    const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
    console.log(`    stdout: "${out.substring(0, 500)}"`);
    assert(out.length > 0, 'Empty output');
  } catch (e) {
    const stderr = e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString('utf-8')) : '';
    const stdout = e.stdout ? (typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf-8')) : '';
    console.log(`    exit code: ${e.status ?? e.code ?? 'unknown'}`);
    console.log(`    stdout: "${stdout.substring(0, 200)}"`);
    console.log(`    stderr: "${stderr.substring(0, 200)}"`);
    console.log(`    message: ${e.message.substring(0, 200)}`);
    throw e;
  }
});

// Test the actual command the agent used
test('execSync "web url=..." (URL command)', () => {
  const cmd = `"${BINARY_PATH}" web url=https://www.reddit.com/r/ollama/comments/1sy485i/sick_of_being_patient_for_ollama_cloud_capacity/ newtab`;
  console.log(`    Raw command: ${cmd.substring(0, 200)}...`);
  try {
    const result = execSync(cmd, { timeout: 15000, encoding: 'utf-8', windowsHide: true });
    const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
    console.log(`    stdout: "${out.substring(0, 500)}"`);
    assert(out.length > 0, 'Empty output');
  } catch (e) {
    const stderr = e.stderr ? (typeof e.stderr === 'string' ? e.stderr : e.stderr.toString('utf-8')) : '';
    const stdout = e.stdout ? (typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf-8')) : '';
    console.log(`    exit code: ${e.status ?? e.code ?? 'unknown'}`);
    console.log(`    stdout: "${stdout.substring(0, 200)}"`);
    console.log(`    stderr: "${stderr.substring(0, 200)}"`);
    console.log(`    message: ${e.message.substring(0, 200)}`);
    throw e;
  }
});

// --- Section 4: shellExecSync-style test (which/where) ---
console.log('');
console.log('--- Section 4: PATH Detection ---');
test('where Obsidian.com (finds in PATH)', () => {
  const result = execSync('where Obsidian.com', { timeout: 5000, encoding: 'utf-8', windowsHide: true });
  const out = (typeof result === 'string' ? result : result.toString('utf-8')).trim();
  console.log(`    found: ${out}`);
  assert(out.length > 0, 'Not found in PATH');
});

// --- Summary ---
console.log('');
console.log('='.repeat(70));
console.log(`Results: ${RESULTS.pass} passed, ${RESULTS.fail} failed`);
console.log('='.repeat(70));

// Exit with appropriate code
process.exit(RESULTS.fail > 0 ? 1 : 0);
