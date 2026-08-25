// Grounded-answer persistence atomically snapshots exact owner-scoped evidence,
// creates queue jobs containing identifiers rather than journal content, and
// records empty-retrieval outcomes without provider work. Run that real database
// contract in the root coverage gate as well as the infrastructure gate.
import './grounded-answer.integration.js';
