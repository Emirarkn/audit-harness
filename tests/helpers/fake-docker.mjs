// Stand-in for the docker CLI in tests/sandbox.test.mjs. Records each call as a JSON line in
// $FAKE_DOCKER_LOG and answers according to $FAKE_DOCKER_MODE (pass | fail | pull-error | down).
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE ?? 'pass';
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');

if (args[0] === 'info') process.exit(mode === 'down' ? 1 : (console.log('27.0.0'), 0));
if (args[0] === 'kill') process.exit(0);
if (args[0] === 'run') {
  const script = args[args.length - 1];
  if (mode === 'pull-error') { console.error('Unable to find image'); process.exit(125); }
  if (/pip install|npm (ci|install)/.test(script) && !/unittest|pytest|npm test/.test(script)) { console.log('installed'); process.exit(0); }
  if (mode === 'fail') { console.error('Ran 3 tests in 0.01s\n\nFAILED (failures=1)'); process.exit(1); }
  console.error('Ran 3 tests in 0.01s\n\nOK');
  process.exit(0);
}
process.exit(2);
