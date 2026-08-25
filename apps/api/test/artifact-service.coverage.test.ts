// Artifact persistence owns transactional revision graphs, idempotency locks,
// ownership joins, and audit records. Keep its real PostgreSQL behavioral suite
// in both the infrastructure gate and the root coverage gate so those paths are
// measured without replacing database semantics with fluent-chain mocks.
import './artifact-service.integration.js';
