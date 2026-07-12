for (let index = 0; index < 400; index++) {
  process.stderr.write(`failure-line-${index}-${'x'.repeat(80)}\n`)
}
process.exit(17)
