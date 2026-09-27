export type RetentionCase = {
  name: string;
  command: string;
  task: string;
  earlierContext: string;
  stdout: string;
  stderr: string;
  exitStatus: number;
  requiredFacts: readonly string[];
  nextAction: string;
  forbiddenConclusions: readonly string[];
  expected: 'pruned' | 'bypass';
};

const progress = (count: number) => Array.from({ length: count }, (_, i) =>
  `progress: cached module ${String(i).padStart(4, '0')} ${'cache '.repeat(24)}`);
const withLine = (rows: string[], index: number, text: string) => {
  const copy = [...rows];
  copy[index] = text;
  return copy.join('\n');
};

// Expectations are fixed here, independently of the three evaluation arms.
export const CASES: readonly RetentionCase[] = [
  {
    name: 'passing tests and artefact', command: 'npm test',
    task: 'Confirm the passing test total and locate the release artefact.',
    earlierContext: 'The release gate needs the exact test total and artefact path.',
    stdout: [...progress(420), 'Tests: 312 passed, 0 failed', 'Artifact: dist/release-312.tar'].join('\n'),
    stderr: '', exitStatus: 0,
    requiredFacts: ['Tests: 312 passed, 0 failed', 'Artifact: dist/release-312.tar'],
    nextAction: 'Inspect dist/release-312.tar before release.',
    forbiddenConclusions: ['tests failed', 'artefact missing'], expected: 'pruned',
  },
  {
    name: 'failed test after misleading success', command: 'npm test',
    task: 'Diagnose the failing checkout test.',
    earlierContext: 'A prior suite passed. Diagnose the current run only.',
    stdout: [...progress(360), 'Tests: 80 passed, 0 failed', ...progress(50),
      'FAILED tests/checkout.test.ts::discount - expected 10, received 7',
      'Tests: 80 passed, 1 failed'].join('\n'),
    stderr: 'AssertionError: expected 10, received 7 at tests/checkout.test.ts:88\n',
    exitStatus: 7,
    requiredFacts: ['FAILED tests/checkout.test.ts::discount - expected 10, received 7',
      'Tests: 80 passed, 1 failed', 'AssertionError: expected 10, received 7 at tests/checkout.test.ts:88'],
    nextAction: 'Inspect the discount assertion at tests/checkout.test.ts:88.',
    forbiddenConclusions: ['all tests passed'], expected: 'bypass',
  },
  {
    name: 'buried warning on zero exit', command: 'npm run build',
    task: 'Check whether the build is safe to ship.',
    earlierContext: 'A zero exit is insufficient if checksum verification warned.',
    stdout: withLine([...progress(420), 'Exit status: 0'], 211,
      'WARNING: checksum mismatch for dist/client.js; expected sha256:abc, got sha256:def'),
    stderr: '', exitStatus: 0,
    requiredFacts: ['WARNING: checksum mismatch for dist/client.js; expected sha256:abc, got sha256:def',
      'Exit status: 0'],
    nextAction: 'Investigate dist/client.js checksum before shipping.',
    forbiddenConclusions: ['safe to ship'], expected: 'pruned',
  },
  {
    name: 'stack frame away from boundaries', command: 'npm test',
    task: 'Find the source line that caused the cart crash.',
    earlierContext: 'Trace the first application frame, not the framework tail.',
    stdout: withLine([...progress(450), 'Tests: 44 passed, 1 failed'], 224,
      '    at CartService.total (src/cart/service.ts:188:17)'),
    stderr: '', exitStatus: 0,
    requiredFacts: ['at CartService.total (src/cart/service.ts:188:17)', 'Tests: 44 passed, 1 failed'],
    nextAction: 'Inspect src/cart/service.ts:188.',
    forbiddenConclusions: ['framework code caused the crash'], expected: 'pruned',
  },
  {
    name: 'repeated output with task value', command: 'npm run build',
    task: 'Record the release fingerprint from this run.',
    earlierContext: 'The release fingerprint is RELEASE_FINGERPRINT=rc7-9ab; retain its exact value.',
    stdout: withLine([...progress(430), 'Build completed'], 214,
      'RELEASE_FINGERPRINT=rc7-9ab'),
    stderr: '', exitStatus: 0,
    requiredFacts: ['RELEASE_FINGERPRINT=rc7-9ab', 'Build completed'],
    nextAction: 'Record RELEASE_FINGERPRINT=rc7-9ab in the release check.',
    forbiddenConclusions: ['fingerprint unavailable'], expected: 'pruned',
  },
  ...([
    ['JSON', 'cat result.json', JSON.stringify({ rows: progress(440), result: { checksum: 'abc123' } }), '"checksum":"abc123"'],
    ['diff', 'git diff', ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
      ...progress(440), '@@ -1 +1 @@', '-old', '+new'].join('\n'), '+new'],
    ['documentation', 'cat GUIDE.md', ['# Release guide', ...progress(440),
      'Required command: npm run verify-release'].join('\n'), 'Required command: npm run verify-release'],
    ['source', 'cat src/main.ts', ['export function release() {', ...progress(440),
      '  return "release-ok";', '}'].join('\n'), 'return "release-ok";'],
  ] as const).map(([kind, command, stdout, fact]) => ({
    name: `${kind} exact passthrough`, command,
    task: `Read the complete ${kind} content without gaps.`,
    earlierContext: 'The whole file is needed for review.',
    stdout, stderr: '', exitStatus: 0, requiredFacts: [fact],
    nextAction: `Review the complete ${kind} content.`,
    forbiddenConclusions: ['content complete after trimming'], expected: 'bypass' as const,
  })),
];
