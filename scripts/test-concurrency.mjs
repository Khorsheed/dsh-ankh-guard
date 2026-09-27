/** Cap lane scheduling with the same opt-in worker budget as the repo preset. */
export function testConcurrency(lane, value = process.env.DSH_TEST_MAX_WORKERS) {
  const maximum = lane === 'unit' ? 2 : 4
  const requested = Number(value ?? '')
  return Number.isInteger(requested) && requested > 0 ? Math.min(maximum, requested) : maximum
}
