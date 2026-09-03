/**
 * Lets the page finish what it started.
 *
 * The console pages chain stubbed `fetch` calls then render; the tests used to
 * wait a fixed 20 ms, which was enough on an idle machine and not on a busy one.
 * The defect only showed on a full run of the suite, on a different test every
 * time — the signature of a wait that is calibrated rather than conditioned.
 *
 * Two forms, and the second is the right one whenever it is available:
 *
 *  - **without an argument**, we yield to the event loop a fixed number of times.
 *    That is enough for short renders, and keeps the calls readable;
 *  - **with a condition**, we poll until it becomes true. That is what is needed
 *    as soon as the page chains several round trips — a decision sent, then the
 *    program read back — because the number of turns needed then depends on the
 *    machine, which a test must never assume.
 *
 * The deadline only serves to fail rather than hang: a condition that never comes
 * is a defect, and the test must say so instead of timing out.
 */
export async function waitForRender(
  condition?: () => boolean,
  deadlineMs = 2_000,
): Promise<void> {
  if (condition == null) {
    for (let turn = 0; turn < 12; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return
  }

  const limit = Date.now() + deadlineMs
  while (!condition()) {
    if (Date.now() > limit) {
      throw new Error(
        'The awaited condition never became true: the page did not finish what it ' +
          'had started, or it will not.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  // One more turn, for the render that follows the last response.
  await new Promise((resolve) => setTimeout(resolve, 0))
}
