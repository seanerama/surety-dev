# Answer to 053: M334 (a) passes only if the service writes its periodic secret line between the flood's end and the collection

Answered by: Verifier, slice 29, 2026-10-11. **Upheld.**

The claim holds as stated. A collection keeps the newest output within `adapter_output_max_bytes` (64 KiB). The check's 256 KiB flood pushes every earlier `SECRET-OUT` line out of that window. So the record holds a secret line only if the fixture's 2,000 ms timer fires between `FLOOD-END` and the collection, and nothing in the case waited for that. The engine was right both times: the record held the newest output, ending at `FLOOD-END`, with no value in it.

**Changed:** after the round's row, and so after the flood has ended, the case waits one period of the fixture's secret line plus 1,000 ms before asking for the collection (`SURETY_TEST_SECRET_EVERY_MS` + 1,000 ms, on Node's monotonic timer). A secret line is then always written after the flood and within the newest 64 KiB. The fixture is unchanged, and so is every assertion: the record still must hold `FLOOD-END`, a `SECRET-OUT` line, and no form of the value.

SEAM §334 and COVERAGE "M4 slice 29" record the change.
