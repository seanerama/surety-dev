// A node:test reporter for the self-check: one JSON line per finished test.
export default async function* jsonReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    yield `${JSON.stringify({
      ok: event.type === 'test:pass',
      name: d.name,
      nesting: d.nesting,
      suite: d.details?.type === 'suite',
      skipped: d.skip !== undefined || d.todo !== undefined,
      error: event.type === 'test:fail' ? String(d.details?.error?.cause?.message ?? d.details?.error?.message ?? '').split('\n')[0].slice(0, 300) : undefined,
    })}\n`;
  }
}
