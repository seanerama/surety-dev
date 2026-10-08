// The runner self-test's mandatory cases (D3 §2.8), by the names SEAM.md
// §208 fixes, in its order.
export const SELF_TEST_CASES = [
  'exit_zero',
  'exit_nonzero',
  'prints_passed_exits_nonzero',
  'foreign_signal',
  'deadline',
  'term_handled_after_cancel',
  'missing_program',
  'input_immutable',
  'orphan_stdout_closed',
  'egress',
] as const;

export type SelfTestCase = (typeof SELF_TEST_CASES)[number];
